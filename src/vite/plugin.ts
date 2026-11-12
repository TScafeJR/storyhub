import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { searchForWorkspaceRoot, type Plugin, type ViteDevServer } from 'vite';
import { cleanId, isNodeModules, isRelativeSpec, realpath, relInside } from '../core/paths.js';
import { StoryHub } from '../core/state.js';
import { isSelected, readSelection, type SelectionOptions } from '../core/selection.js';
import { listWorktrees } from '../core/worktrees.js';
import { BRANCH_FROM_LOCATION, branchImportersCode } from '../codegen.js';
import { viteResolver } from './resolver.js';

const STORIES_MODULE = 'storybook-stories.js';
const ANNOTATIONS_MODULE = 'project-annotations.js';

export interface StoryhubVitePluginOptions {
    gitRoot: string;
    configDir: string;
    isStoryFile: (rel: string) => boolean;
    /** Git-root-relative preview annotation files of the project (see StoryHubOptions.previewFiles). */
    previewFiles?: string[];
    selection?: SelectionOptions;
    refBase?: string;
    /** Called once the hub is ready (the dev server and its resolver exist). */
    onHub?: (hub: StoryHub, server: ViteDevServer) => void;
    log?: (msg: string) => void;
}

/**
 * Code appended to builder-vite's project-annotations module. In a branch iframe it loads that
 * branch's copy of any preview file the branch dirties (for example a preview that provides a
 * context whose module the branch changed) and hands them to getProjectAnnotations through the
 * same override slot builder-vite uses for HMR. The hub iframe is untouched.
 */
export function previewOverridesCode(code: string, hub: StoryHub | undefined, root: string, gitRoot: string): string {
    const specs = [...code.matchAll(/^\s*import \* as \w+ from ['"]([^'"]+)['"];?\s*$/gm)].map(m => m[1]);
    const toRel = (spec: string): string | null => {
        for (const candidate of [spec, join(root, spec)]) {
            if (candidate.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(candidate)) {
                if (existsSync(candidate)) return relInside(gitRoot, realpath(candidate));
            }
        }
        return null;
    };
    const rels = specs.map(toRel);
    const byBranch: string[] = [];
    for (const b of hub?.branches.values() ?? []) {
        const loaders: string[] = [];
        rels.forEach((rel, i) => {
            if (rel && b.previewOverrides.includes(rel)) loaders.push(`${i}: () => import(${JSON.stringify(join(b.worktree.path, rel))})`);
        });
        if (loaders.length) byBranch.push(`  ${JSON.stringify(b.worktree.id)}: { ${loaders.join(', ')} }`);
    }
    if (!byBranch.length) return '';
    return `
// --- storyhub: per-branch preview files ---
const __storyhubPreviewOverrides = {
${byBranch.join(',\n')}
};
const __storyhubBranch = ${BRANCH_FROM_LOCATION};
const __storyhubPreviewModules = [];
if (__storyhubBranch && __storyhubPreviewOverrides[__storyhubBranch]) {
  for (const [i, load] of Object.entries(__storyhubPreviewOverrides[__storyhubBranch])) __storyhubPreviewModules[Number(i)] = await load();
}
if (__storyhubPreviewModules.length) {
  const __storyhubOriginalGetProjectAnnotations = getProjectAnnotations;
  getProjectAnnotations = function storyhubGetProjectAnnotations(hmrPreviewAnnotationModules = []) {
    const merged = [...hmrPreviewAnnotationModules];
    __storyhubPreviewModules.forEach((m, i) => { if (m) merged[i] = m; });
    return __storyhubOriginalGetProjectAnnotations(merged);
  };
}
`;
}

/**
 * Serves each worktree's changed files on top of the hub's modules.
 *
 * Imports made from a worktree module resolve as if made from the hub's twin of that file, so
 * aliases and bare packages behave identically and dependencies come from the hub's node_modules.
 * The resolved file then lands in the worktree only when it is dirty for that branch (changed, or
 * importing something changed); otherwise the hub's module instance is shared.
 */
export function storyhubVitePlugin(opts: StoryhubVitePluginOptions): Plugin {
    let hub: StoryHub | undefined;
    let hubPromise: Promise<StoryHub> | undefined;
    let server: ViteDevServer | undefined;
    let allow: string[] | undefined;
    let viteRoot = process.cwd();

    const allowRoots = (roots: string[]) => {
        if (!allow) return;
        for (const r of roots) if (!allow.includes(r)) allow.push(r);
    };

    /** builder-vite regenerates (and HMR-patches) its virtual modules on a watcher change event. */
    const regenerate = (suffix: string) => {
        if (!server) return;
        for (const id of server.moduleGraph.idToModuleMap.keys()) if (id.endsWith(suffix)) server.watcher.emit('change', id);
    };

    const onChange = () => {
        if (!hub) return;
        allowRoots(hub.worktrees.map(w => w.path));
        regenerate(STORIES_MODULE);
    };

    /** Resolution decisions baked into transformed worktree modules are stale for these branches. */
    const onStructure = (ids: string[]) => {
        if (!hub || !server) return;
        for (const id of ids) {
            const b = hub.branches.get(id);
            if (!b) continue;
            for (const [file, mods] of server.moduleGraph.fileToModulesMap) {
                if (relInside(b.worktree.path, file) !== null) for (const m of mods) server.moduleGraph.invalidateModule(m);
            }
        }
    };

    const start = (): Promise<StoryHub> => {
        if (!server) return Promise.reject(new Error('storyhub: dev server not ready'));
        hubPromise ??= StoryHub.create({
            cwd: opts.gitRoot,
            configDir: opts.configDir,
            isStoryFile: opts.isStoryFile,
            previewFiles: opts.previewFiles,
            selection: opts.selection,
            resolve: viteResolver(server),
            refBase: opts.refBase,
            watch: { hub: false },
            // reuse Vite's chokidar (it already ignores node_modules/.git) for worktree trees
            addWatchRoots: roots => server!.watcher.add(roots),
            log: opts.log
        }).then(h => {
            hub = h;
            allowRoots(h.worktrees.map(w => w.path));
            server!.watcher.on('all', (event, file) => h.notify(event, file));
            h.on('change', onChange);
            h.on('structure', onStructure);
            h.on('previews', () => regenerate(ANNOTATIONS_MODULE));
            server!.httpServer?.once('close', () => void h.close());
            opts.onHub?.(h, server!);
            onChange();
            return h;
        });
        return hubPromise;
    };

    return {
        name: 'storyhub',
        enforce: 'pre',
        apply: 'serve',

        async config(config) {
            const root = config.root ?? process.cwd();
            const selection = await readSelection(opts.gitRoot, opts.selection).catch(() => null);
            const worktrees = selection ? (await listWorktrees(opts.gitRoot).catch(() => [])).filter(w => isSelected(w, selection)) : [];
            const existing = config.server?.fs?.allow;
            const base = existing && existing.length ? [] : [searchForWorkspaceRoot(root)];
            return { server: { fs: { allow: [...base, opts.gitRoot, ...worktrees.map(w => w.path)] } } };
        },

        configResolved(config) {
            allow = config.server.fs.allow as string[];
            viteRoot = config.root;
        },

        configureServer(s) {
            server = s;
            // resolution needs a started plugin container; kick off after createServer settles
            setTimeout(() => void start().catch(err => opts.log?.(`storyhub: failed to start: ${err?.stack ?? err}`)), 0);
            const close = s.close.bind(s);
            s.close = async () => {
                await hub?.close();
                return close();
            };
        },

        async resolveId(source, importer, options) {
            if ((options?.custom as { storyhub?: { raw?: boolean } } | undefined)?.storyhub?.raw) return null;
            if (!hub || !importer || source.startsWith('\0') || importer.startsWith('\0')) return null;
            const imp = cleanId(importer);
            const branch = hub.branchForPath(imp);
            if (!branch) return null;
            const wt = branch.worktree.path;
            const twin = join(hub.root, relInside(wt, imp)!);
            const resolveOpts = { ...options, skipSelf: true };
            let r = await this.resolve(source, twin, resolveOpts);
            if (!r && isRelativeSpec(source)) r = await this.resolve(source, imp, resolveOpts);
            if (!r || r.external) return r;
            const q = r.id.search(/[?#]/);
            const path = q === -1 ? r.id : r.id.slice(0, q);
            const query = q === -1 ? '' : r.id.slice(q);
            if (path.startsWith('\0') || !existsSync(path)) return r;
            const real = realpath(path);
            if (isNodeModules(real)) return r;
            const rel = relInside(hub.root, real) ?? relInside(wt, real);
            if (rel === null) return r;
            const inBranch = join(wt, rel);
            const inHub = join(hub.root, rel);
            if (branch.dirty.has(rel) && existsSync(inBranch)) return { ...r, id: inBranch + query };
            if (existsSync(inHub)) return { ...r, id: inHub + query };
            return { ...r, id: inBranch + query };
        },

        transform(code, id) {
            if (id.endsWith(STORIES_MODULE) && code.includes('importFn')) return { code: code + branchImportersCode(hub), map: null };
            if (id.endsWith(ANNOTATIONS_MODULE) && code.includes('getProjectAnnotations')) {
                const extra = previewOverridesCode(code, hub, viteRoot, opts.gitRoot);
                return extra ? { code: code + extra, map: null } : null;
            }
            return null;
        }
    };
}
