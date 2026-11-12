import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Compiler, Configuration, RuleSetCondition, RuleSetRule } from 'webpack';
import { cleanId, isNodeModules, isRelativeSpec, realpath, relInside } from '../core/paths.js';
import { isSelected, readSelection, type SelectionOptions } from '../core/selection.js';
import { StoryHub } from '../core/state.js';
import type { ResolveFn } from '../core/types.js';
import { listWorktrees } from '../core/worktrees.js';
import { sessions, type WebpackSession } from './session.js';

export interface StoryhubWebpackOptions {
    gitRoot: string;
    configDir: string;
    isStoryFile: (rel: string) => boolean;
    previewFiles?: string[];
    selection?: SelectionOptions;
    refBase?: string;
    onHub?: (hub: StoryHub) => void;
    log?: (msg: string) => void;
}

const NAME = 'storyhub';
const LOADER = fileURLToPath(new URL('./webpack-loader.cjs', import.meta.url));

/** The hub-checkout twin of a path inside a selected worktree (other paths are returned as is). */
function toHub(session: WebpackSession, p: string): string {
    for (const root of session.roots) {
        const rel = relInside(root, p);
        if (rel !== null) return join(session.gitRoot, rel);
    }
    return p;
}

type Condition = RuleSetCondition | RuleSetCondition[] | undefined;

/** webpack's condition semantics: string prefix, RegExp, function, array (any), {and, or, not}. */
function matches(cond: Condition, value: string): boolean {
    if (cond === undefined || cond === null) return true;
    if (typeof cond === 'string') return value.startsWith(cond);
    if (cond instanceof RegExp) {
        cond.lastIndex = 0;
        return cond.test(value);
    }
    if (typeof cond === 'function') return Boolean((cond as (v: string) => unknown)(value));
    if (Array.isArray(cond)) return cond.some(c => matches(c as Condition, value));
    const logical = cond as { and?: Condition[]; or?: Condition[]; not?: Condition };
    let ok = true;
    if (logical.and) ok &&= logical.and.every(c => matches(c, value));
    if (logical.or) ok &&= logical.or.some(c => matches(c, value));
    if (logical.not !== undefined) ok &&= !matches(logical.not, value);
    return ok;
}

/**
 * Rules decide loaders by path (e.g. `include: path.resolve('src')`), which worktree paths would
 * fail. Each path condition is evaluated against the file's hub twin instead, so a worktree file
 * gets exactly the loaders its hub counterpart gets. Hub paths behave as before.
 */
export function wrapRules(rules: Array<RuleSetRule | '...' | false | null | undefined | 0 | ''> | undefined, session: WebpackSession): void {
    for (const rule of rules ?? []) {
        if (!rule || typeof rule !== 'object') continue;
        for (const key of ['test', 'include', 'exclude', 'resource', 'issuer'] as const) {
            const cond = rule[key] as Condition;
            if (cond === undefined) continue;
            (rule as Record<string, unknown>)[key] = (value: string) => matches(cond, toHub(session, value));
        }
        wrapRules(rule.oneOf as RuleSetRule[] | undefined, session);
        wrapRules(rule.rules as RuleSetRule[] | undefined, session);
    }
}

/** A ResolveFn backed by the compiler's own configured resolver (aliases, tsconfig paths, exports). */
function webpackResolver(compiler: Compiler): ResolveFn {
    const resolver = compiler.resolverFactory.get('normal', { dependencyType: 'esm' });
    return (spec, importer) =>
        new Promise(resolve => {
            resolver.resolve({}, dirname(importer), spec, {}, (err, result) => resolve(err || typeof result !== 'string' ? null : cleanId(result)));
        });
}

const replaceLast = (s: string, find: string, replacement: string) => {
    const i = s.lastIndexOf(find);
    return i === -1 ? s : s.slice(0, i) + replacement + s.slice(i + find.length);
};

class StoryhubWebpackPlugin {
    constructor(private opts: StoryhubWebpackOptions, private session: WebpackSession) {}

    apply(compiler: Compiler): void {
        const { session, opts } = this;
        const invalidate = () => compiler.watching?.invalidate();

        compiler.hooks.afterResolvers.tap(NAME, () => {
            if (session.hub) return;
            void StoryHub.create({
                cwd: opts.gitRoot,
                configDir: opts.configDir,
                isStoryFile: opts.isStoryFile,
                previewFiles: opts.previewFiles,
                selection: opts.selection,
                resolve: webpackResolver(compiler),
                refBase: opts.refBase,
                watch: { hub: false },
                log: opts.log
            })
                .then(hub => {
                    session.hub = hub;
                    const sync = () => (session.roots = hub.worktrees.filter(w => !w.isHub).map(w => w.path));
                    sync();
                    hub.on('change', () => {
                        sync();
                        invalidate();
                    });
                    hub.on('structure', invalidate);
                    hub.on('previews', invalidate);
                    compiler.hooks.shutdown.tap(NAME, () => void hub.close());
                    opts.onHub?.(hub);
                    invalidate(); // the first build may have run before the hub was ready
                })
                .catch(err => opts.log?.(`storyhub: failed to start: ${err?.stack ?? err}`));
        });

        // Worktree modules are rebuilt on every compilation so their imports re-resolve when a
        // branch's dirty set changes. Done through buildInfo rather than a loader rule: a loader
        // would change the module's request, and a file redirected back to the hub must keep
        // exactly the hub's request to stay one shared module instance.
        compiler.hooks.thisCompilation.tap(NAME, compilation => {
            compilation.hooks.succeedModule.tap(NAME, module => {
                const resource = (module as { resource?: string }).resource;
                if (resource && module.buildInfo && !isNodeModules(resource) && session.roots.some(r => relInside(r, resource) !== null)) module.buildInfo.cacheable = false;
            });
        });

        // hub-side edits reach the graph through webpack's own watcher
        compiler.hooks.watchRun.tap(NAME, c => {
            for (const f of c.modifiedFiles ?? []) session.hub?.notify('change', f);
            for (const f of c.removedFiles ?? []) session.hub?.notify('unlink', f);
        });

        compiler.hooks.normalModuleFactory.tap(NAME, nmf => {
            // Non-relative imports from a worktree module resolve from its hub twin's directory, so
            // packages and aliases come from the hub (one React, no stray node_modules). Relative
            // imports keep the worktree context so files new in the branch are found.
            nmf.hooks.beforeResolve.tap(NAME, data => {
                const hub = session.hub;
                const issuer = data.contextInfo?.issuer;
                if (!hub || !issuer || data.request.includes('!') || isRelativeSpec(data.request)) return;
                const branch = hub.branchForPath(issuer);
                if (!branch) return;
                const twinDir = join(hub.root, relInside(branch.worktree.path, data.context) ?? '');
                data.context = existsSync(twinDir) ? twinDir : process.cwd();
            });

            // Then the resolved file is served from the worktree only if it is dirty for the
            // importer's branch; otherwise the hub's module (and module instance) is shared.
            nmf.hooks.afterResolve.tap(NAME, data => {
                const hub = session.hub;
                const issuer = data.contextInfo?.issuer;
                const created = data.createData as { resource?: string; request?: string; userRequest?: string; context?: string; resourceResolveData?: Record<string, unknown> };
                if (!hub || !issuer || !created.resource) return;
                const branch = hub.branchForPath(issuer);
                if (!branch) return;
                const q = created.resource.search(/[?#]/);
                const path = q === -1 ? created.resource : created.resource.slice(0, q);
                const query = q === -1 ? '' : created.resource.slice(q);
                if (!existsSync(path)) return;
                const real = realpath(path);
                const wt = branch.worktree.path;
                const rel = relInside(hub.root, real) ?? relInside(wt, real);
                if (rel === null) return;
                const inBranch = join(wt, rel);
                const inHub = join(hub.root, rel);
                let target: string;
                if (isNodeModules(real)) target = existsSync(inHub) ? inHub : real;
                else if (branch.dirty.has(rel) && existsSync(inBranch)) target = inBranch;
                else target = existsSync(inHub) ? inHub : inBranch;
                if (target === path) return;
                created.resource = target + query;
                created.context = dirname(target); // where the module resolves its own imports from
                if (created.request) created.request = replaceLast(created.request, path, target);
                if (created.userRequest) created.userRequest = replaceLast(created.userRequest, path, target);
                if (created.resourceResolveData) created.resourceResolveData = { ...created.resourceResolveData, path: target, context: undefined };
            });
        });
    }
}

/** Applies storyhub to builder-webpack5's final config (dev only; the preset checks that). */
export async function storyhubWebpackFinal(config: Configuration, opts: StoryhubWebpackOptions): Promise<Configuration> {
    const key = opts.configDir;
    const selection = await readSelection(opts.gitRoot, opts.selection).catch(() => null);
    const roots = selection ? (await listWorktrees(opts.gitRoot).catch(() => [])).filter(w => isSelected(w, selection)).map(w => w.path) : [];
    const session: WebpackSession = sessions().get(key) ?? { gitRoot: opts.gitRoot, roots };
    sessions().set(key, session);

    const workingDir = process.cwd();
    const generated = (file: string) => (p: string) => p === join(workingDir, file);

    config.module ??= {};
    config.module.rules ??= [];
    wrapRules(config.module.rules as RuleSetRule[], session);
    config.module.rules.unshift(
        { test: generated('storybook-stories.js'), enforce: 'pre', use: [{ loader: LOADER, options: { key, kind: 'stories' } }] },
        { test: generated('storybook-config-entry.js'), enforce: 'pre', use: [{ loader: LOADER, options: { key, kind: 'entry' } }] }
    );
    config.plugins = [...(config.plugins ?? []), new StoryhubWebpackPlugin(opts, session)];
    return config;
}
