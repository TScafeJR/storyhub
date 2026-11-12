import { EventEmitter } from 'node:events';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { join, resolve } from 'node:path';
import { classifyDrift, mergeBase, workingChanges } from './diff.js';
import { git } from './git.js';
import { buildBranchGraph, buildHubGraph, importChain, ResolveCache, reverseClosure, SpecCache, type Edges, type GraphContext } from './graph.js';
import { realpath, relInside, toPosix } from './paths.js';
import type { BranchState, BranchSummary, FileChange, ResolveFn, Worktree } from './types.js';
import { isSelected, readSelection, type SelectionOptions } from './selection.js';
import { gitToplevel, listWorktrees } from './worktrees.js';

export interface StoryHubOptions {
    /** Any directory inside the checkout that runs Storybook. */
    cwd: string;
    /** Absolute Storybook config dir; changes under it in a branch flag `config-drift`. */
    configDir?: string;
    /** Whether a git-root-relative path is a story file Storybook would index. */
    isStoryFile: (rel: string) => boolean;
    /**
     * Git-root-relative project files Storybook loads into every preview (e.g. .storybook/preview.tsx).
     * They join the import graph so a branch that dirties something they import gets its own copy.
     */
    previewFiles?: string[];
    /** Which worktrees become branches (opt-in by default; see selection.ts). */
    selection?: SelectionOptions;
    resolve: ResolveFn;
    /** URL prefix the branch refs are served from. */
    refBase?: string;
    /** Watch worktrees and git metadata, refreshing automatically. */
    watch?: boolean | { hub?: boolean };
    /**
     * Adds directory trees to an existing watcher whose events reach `notify()` (e.g. Vite's, which
     * already ignores node_modules and .git). Without one, storyhub falls back to fs.watch.
     */
    addWatchRoots?: (roots: string[]) => void;
    debounceMs?: number;
    log?: (msg: string) => void;
}

export interface InternalBranch extends BranchState {
    edges: Edges;
}

const IGNORED = /(^|[\\/])(node_modules|\.git|dist|storybook-static|\.turbo|\.next|coverage)([\\/]|$)/;

export class StoryHub extends EventEmitter {
    readonly root: string;
    readonly refBase: string;
    /** The hub plus every selected worktree. */
    worktrees: Worktree[] = [];
    /** Every worktree of the repo, selected or not. */
    allWorktrees: Array<Worktree & { selected: boolean }> = [];
    branches = new Map<string, InternalBranch>();
    hubEdges: Edges = new Map();
    hubStories: string[] = [];
    private ctx: GraphContext;
    private watchers: FSWatcher[] = [];
    private timer: NodeJS.Timeout | undefined;
    private running: Promise<void> | null = null;
    private rerun = false;
    private lastFingerprint = '';
    /** Per-branch shape (dirty files + affected stories); a change means rendered modules are stale. */
    private shapes = new Map<string, string>();
    private previewFingerprint: string | undefined;
    private configDirRel: string | null;

    private constructor(root: string, private opts: StoryHubOptions) {
        super();
        this.root = root;
        this.refBase = (opts.refBase ?? '/__storyhub').replace(/\/$/, '');
        this.ctx = { hubRoot: root, specs: new SpecCache(), resolver: new ResolveCache(opts.resolve) };
        this.configDirRel = opts.configDir ? relInside(root, realpath(opts.configDir)) : null;
    }

    static async create(opts: StoryHubOptions): Promise<StoryHub> {
        const hub = new StoryHub(await gitToplevel(opts.cwd), opts);
        await hub.refresh();
        if (opts.watch) await hub.startWatching();
        return hub;
    }

    /** Recomputes everything. Concurrent calls coalesce into one extra run. */
    refresh(): Promise<void> {
        if (this.running) {
            this.rerun = true;
            return this.running;
        }
        this.running = (async () => {
            try {
                do {
                    this.rerun = false;
                    await this.compute();
                } while (this.rerun);
            } finally {
                this.running = null;
            }
        })();
        return this.running;
    }

    private async compute(): Promise<void> {
        const started = Date.now();
        const all = await listWorktrees(this.root);
        const selection = await readSelection(this.root, this.opts.selection);
        const allWorktrees = all.map(wt => ({ ...wt, selected: isSelected(wt, selection) }));
        const worktrees = allWorktrees.filter(wt => wt.isHub || wt.selected);
        const hubHead = (await git(this.root, ['rev-parse', 'HEAD'])).trim();
        const files = (await git(this.root, ['ls-files', '-co', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
        const hubStories = files.filter(rel => this.opts.isStoryFile(rel));
        const previewFiles = this.opts.previewFiles ?? [];
        const hubEdges = await buildHubGraph(this.ctx, [...hubStories, ...previewFiles]);
        const hubSideByBase = new Map<string, Promise<FileChange[]>>();

        const branches = new Map<string, InternalBranch>();
        await Promise.all(
            worktrees
                .filter(wt => !wt.isHub)
                .map(async wt => {
                    branches.set(wt.id, await this.computeBranch(wt, hubHead, hubStories, hubEdges, hubSideByBase));
                })
        );

        this.worktrees = worktrees;
        this.allWorktrees = allWorktrees;
        this.hubStories = hubStories;
        this.hubEdges = hubEdges;
        this.branches = new Map([...branches].sort(([a], [b]) => a.localeCompare(b)));
        this.syncWatchers();

        // 'structure': branches whose dirty set or story list changed since the last refresh. Their
        // already-built modules may resolve imports the old way, so builders rebuild them and
        // their iframes reload. Branches seen for the first time need no reload.
        const shapes = new Map([...this.branches].map(([id, b]) => [id, JSON.stringify([[...b.dirty].sort(), b.affectedStories])]));
        const restructured = [...shapes].filter(([id, shape]) => this.shapes.has(id) && this.shapes.get(id) !== shape).map(([id]) => id);
        this.shapes = shapes;
        // 'previews': which branches load their own preview files changed
        const previewFingerprint = JSON.stringify([...this.branches.values()].filter(b => b.previewOverrides.length).map(b => [b.worktree.id, b.previewOverrides]));
        const previewsChanged = this.previewFingerprint !== undefined && this.previewFingerprint !== previewFingerprint;
        this.previewFingerprint = previewFingerprint;

        const fingerprint = JSON.stringify([...this.branches.values()].map(b => [b.worktree, b.mergeBase, b.changes, b.drift, b.affectedStories, b.previewOverrides, b.error]));
        if (fingerprint !== this.lastFingerprint) {
            this.lastFingerprint = fingerprint;
            this.opts.log?.(`storyhub: ${this.branches.size} branch(es) refreshed in ${Date.now() - started}ms`);
            this.emit('change', this.summaries());
        }
        if (previewsChanged) this.emit('previews');
        if (restructured.length) this.emit('structure', restructured);
    }

    private async computeBranch(
        wt: Worktree,
        hubHead: string,
        hubStories: string[],
        hubEdges: Edges,
        hubSideByBase: Map<string, Promise<FileChange[]>>
    ): Promise<InternalBranch> {
        const empty: InternalBranch = { worktree: wt, mergeBase: '', changes: [], drift: [], diverged: [], dirty: new Set(), affectedStories: [], staleFiles: [], previewOverrides: [], missingDeps: [], edges: new Map() };
        try {
            const base = await mergeBase(this.root, hubHead, wt.head);
            if (!base) return { ...empty, error: 'no common history with the hub checkout' };
            let hubSide = hubSideByBase.get(base);
            if (!hubSide) hubSideByBase.set(base, (hubSide = workingChanges(this.root, base)));
            const [changes, hubChanges] = await Promise.all([workingChanges(wt.path, base), hubSide]);
            const hubChanged = new Set(hubChanges.map(c => c.rel));
            const diverged = changes.filter(c => hubChanged.has(c.rel)).map(c => c.rel);

            const deleted = new Set(changes.filter(c => c.kind === 'D').map(c => c.rel));
            const entries = new Set(hubStories.filter(s => !deleted.has(s)));
            for (const c of changes) if (c.kind !== 'D' && this.opts.isStoryFile(c.rel)) entries.add(c.rel);

            const previewFiles = this.opts.previewFiles ?? [];
            const graph = await buildBranchGraph(this.ctx, hubEdges, wt.path, changes, [...entries, ...previewFiles]);
            const dirty = reverseClosure(graph.edges, changes.map(c => c.rel));
            // A story main added after this branch split is unchanged here but absent from the
            // worktree; it cannot render in the branch's module namespace, so it is not offered.
            const affectedStories = [...entries].filter(s => dirty.has(s) && existsSync(join(wt.path, s))).sort();
            const drift = classifyDrift(changes, this.configDirRel, diverged, new Set(previewFiles));
            const previewOverrides = previewFiles.filter(f => dirty.has(f) && existsSync(join(wt.path, f)));
            const changedRels = new Set(changes.map(c => c.rel));
            const staleFiles = [...dirty].filter(f => hubChanged.has(f) && !changedRels.has(f) && existsSync(join(wt.path, f))).sort();
            if (staleFiles.length) drift.push('behind');
            if (graph.missingDeps.length) drift.push('missing-dep');
            return { worktree: wt, mergeBase: base, changes, drift, diverged, dirty, affectedStories, staleFiles, previewOverrides, missingDeps: graph.missingDeps, edges: graph.edges };
        } catch (err) {
            return { ...empty, error: err instanceof Error ? err.message : String(err) };
        }
    }

    summaries(): BranchSummary[] {
        return [...this.branches.values()].map(b => ({
            id: b.worktree.id,
            branch: b.worktree.branch,
            path: b.worktree.path,
            head: b.worktree.head,
            mergeBase: b.mergeBase,
            drift: b.drift,
            changedFiles: b.changes.length,
            affectedStories: b.affectedStories.length,
            refUrl: `${this.refBase}/${b.worktree.id}`,
            ...(b.error ? { error: b.error } : {})
        }));
    }

    /** The branch whose worktree contains `abs`, if any. */
    branchForPath(abs: string): InternalBranch | undefined {
        for (const b of this.branches.values()) if (relInside(b.worktree.path, abs) !== null) return b;
        return undefined;
    }

    /** Import chain from a story to the nearest changed file, explaining why it is affected. */
    reason(branchId: string, storyRel: string): string[] | null {
        const b = this.branches.get(branchId);
        if (!b) return null;
        return importChain(b.edges, storyRel, new Set(b.changes.map(c => c.rel)));
    }

    /** Feed file events from an existing watcher (e.g. Vite's) instead of watching the hub twice. */
    notify(event: string, abs: string): void {
        if (IGNORED.test(abs)) return;
        if (event === 'add' || event === 'unlink' || event === 'addDir' || event === 'unlinkDir') {
            this.ctx.resolver.clear();
            this.ctx.specs.invalidate(abs);
        }
        this.schedule();
    }

    schedule(): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.refresh().catch(err => this.opts.log?.(`storyhub: refresh failed: ${err}`)), this.opts.debounceMs ?? 250);
    }

    private watchedRoots = new Set<string>();
    private commonDir = '';

    private async startWatching(): Promise<void> {
        // relative (".git") from the main checkout but absolute from a linked worktree: resolve
        // handles both, where join would glue an absolute path onto the root
        this.commonDir = realpath(resolve(this.root, (await git(this.root, ['rev-parse', '--git-common-dir'])).trim()));
        // git metadata: HEAD/packed-refs at the top, plus refs/ and worktrees/ (both small trees)
        this.watchGit(this.commonDir, false);
        this.watchGit(join(this.commonDir, 'refs'), true);
        this.watchGit(join(this.commonDir, 'worktrees'), true);
        const watchHub = typeof this.opts.watch === 'object' ? this.opts.watch.hub !== false : true;
        if (watchHub) this.addTree(this.root);
        this.syncWatchers();
    }

    private watchGit(dir: string, recursive: boolean): void {
        if (this.watchedRoots.has(dir) || !existsSync(dir)) return;
        try {
            const w = watch(dir, { recursive }, (_event, file) => {
                const name = file ? toPosix(String(file)) : '';
                if (/(^|\/)(objects|logs|hooks|lfs|info)(\/|$)/.test(name) || name.endsWith('.lock')) return;
                if (!recursive && name === 'worktrees') this.watchGit(join(this.commonDir, 'worktrees'), true);
                this.ctx.resolver.clear();
                this.schedule();
            });
            w.on('error', () => this.watchedRoots.delete(dir));
            this.watchedRoots.add(dir);
            this.watchers.push(w);
        } catch {
            // unwatchable (e.g. removed meanwhile); a later refresh retries
        }
    }

    private addTree(root: string): void {
        if (this.watchedRoots.has(root)) return;
        this.watchedRoots.add(root);
        if (this.opts.addWatchRoots) {
            this.opts.addWatchRoots([root]);
            return;
        }
        try {
            const w = watch(root, { recursive: true }, (event, file) => {
                if (!file) return;
                this.notify(event === 'rename' ? 'add' : 'change', join(root, String(file)));
            });
            w.on('error', () => this.watchedRoots.delete(root));
            this.watchers.push(w);
        } catch {
            this.watchedRoots.delete(root);
        }
    }

    private syncWatchers(): void {
        if (!this.commonDir) return;
        this.watchGit(join(this.commonDir, 'worktrees'), true);
        for (const wt of this.worktrees) if (!wt.isHub) this.addTree(wt.path);
    }

    async close(): Promise<void> {
        clearTimeout(this.timer);
        for (const w of this.watchers) w.close();
        this.watchers = [];
        this.watchedRoots.clear();
    }
}
