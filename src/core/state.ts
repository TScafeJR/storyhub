import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { classifyDrift, mergeBase, workingChanges } from './diff.js';
import { git } from './git.js';
import { buildBranchGraph, buildHubGraph, importChain, ResolveCache, reverseClosure, SpecCache, type Edges, type GraphContext } from './graph.js';
import { realpath, relInside, toPosix } from './paths.js';
import type { BranchState, BranchSummary, FileChange, ResolveFn, Worktree } from './types.js';
import { gitToplevel, listWorktrees } from './worktrees.js';

export interface StoryHubOptions {
    /** Any directory inside the checkout that runs Storybook. */
    cwd: string;
    /** Absolute Storybook config dir; changes under it in a branch flag `config-drift`. */
    configDir?: string;
    /** Whether a git-root-relative path is a story file Storybook would index. */
    isStoryFile: (rel: string) => boolean;
    resolve: ResolveFn;
    /** URL prefix the branch refs are served from. */
    refBase?: string;
    /** Watch worktrees and git metadata, refreshing automatically. */
    watch?: boolean | { hub?: boolean };
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
    worktrees: Worktree[] = [];
    branches = new Map<string, InternalBranch>();
    hubEdges: Edges = new Map();
    hubStories: string[] = [];
    private ctx: GraphContext;
    private watchers: FSWatcher[] = [];
    private timer: NodeJS.Timeout | undefined;
    private running: Promise<void> | null = null;
    private rerun = false;
    private lastFingerprint = '';
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
        const worktrees = await listWorktrees(this.root);
        const hubHead = (await git(this.root, ['rev-parse', 'HEAD'])).trim();
        const files = (await git(this.root, ['ls-files', '-co', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
        const hubStories = files.filter(rel => this.opts.isStoryFile(rel));
        const hubEdges = await buildHubGraph(this.ctx, hubStories);
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
        this.hubStories = hubStories;
        this.hubEdges = hubEdges;
        this.branches = new Map([...branches].sort(([a], [b]) => a.localeCompare(b)));
        this.syncWatchers();

        const fingerprint = JSON.stringify([...this.branches.values()].map(b => [b.worktree, b.mergeBase, b.changes, b.drift, b.affectedStories, b.error]));
        if (fingerprint !== this.lastFingerprint) {
            this.lastFingerprint = fingerprint;
            this.opts.log?.(`storyhub: ${this.branches.size} branch(es) refreshed in ${Date.now() - started}ms`);
            this.emit('change', this.summaries());
        }
    }

    private async computeBranch(
        wt: Worktree,
        hubHead: string,
        hubStories: string[],
        hubEdges: Edges,
        hubSideByBase: Map<string, Promise<FileChange[]>>
    ): Promise<InternalBranch> {
        const empty: InternalBranch = { worktree: wt, mergeBase: '', changes: [], drift: [], diverged: [], dirty: new Set(), affectedStories: [], missingDeps: [], edges: new Map() };
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

            const graph = await buildBranchGraph(this.ctx, hubEdges, wt.path, changes, [...entries]);
            const dirty = reverseClosure(graph.edges, changes.map(c => c.rel));
            // A story main added after this branch split is unchanged here but absent from the
            // worktree; it cannot render in the branch's module namespace, so it is not offered.
            const affectedStories = [...entries].filter(s => dirty.has(s) && existsSync(join(wt.path, s))).sort();
            const drift = classifyDrift(changes, this.configDirRel, diverged);
            if (graph.missingDeps.length) drift.push('missing-dep');
            return { worktree: wt, mergeBase: base, changes, drift, diverged, dirty, affectedStories, missingDeps: graph.missingDeps, edges: graph.edges };
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
        if (event === 'add' || event === 'unlink' || event === 'addDir' || event === 'unlinkDir') this.ctx.resolver.clear();
        this.schedule();
    }

    schedule(): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.refresh().catch(err => this.opts.log?.(`storyhub: refresh failed: ${err}`)), this.opts.debounceMs ?? 250);
    }

    private watchedRoots = new Set<string>();

    private async startWatching(): Promise<void> {
        const commonDir = realpath(join(this.root, (await git(this.root, ['rev-parse', '--git-common-dir'])).trim()));
        const gitWatcher = watch(commonDir, {
            ignoreInitial: true,
            depth: 4,
            ignored: p => /[\\/](objects|logs|hooks|lfs|info)([\\/]|$)/.test(p) || /\.lock$/.test(p)
        });
        gitWatcher.on('all', (_e, p) => {
            const rel = toPosix(relative(commonDir, p));
            if (rel === 'HEAD' || rel.startsWith('refs/') || rel.startsWith('worktrees') || rel === 'packed-refs') {
                this.ctx.resolver.clear();
                this.schedule();
            }
        });
        this.watchers.push(gitWatcher);
        const watchHub = typeof this.opts.watch === 'object' ? this.opts.watch.hub !== false : true;
        if (watchHub) this.addTreeWatcher(this.root);
        this.syncWatchers();
    }

    private addTreeWatcher(root: string): void {
        if (this.watchedRoots.has(root)) return;
        this.watchedRoots.add(root);
        const w = watch(root, { ignoreInitial: true, ignored: p => IGNORED.test(p) });
        w.on('all', (e, p) => this.notify(e, p));
        this.watchers.push(w);
    }

    private syncWatchers(): void {
        if (!this.watchers.length) return;
        for (const wt of this.worktrees) if (!wt.isHub) this.addTreeWatcher(wt.path);
    }

    async close(): Promise<void> {
        clearTimeout(this.timer);
        await Promise.all(this.watchers.map(w => w.close()));
        this.watchers = [];
        this.watchedRoots.clear();
    }
}
