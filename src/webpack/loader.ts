import { join } from 'node:path';
import { BRANCH_FROM_LOCATION, branchImportersCode } from '../codegen.js';
import { realpath, relInside } from '../core/paths.js';
import { CACHE_DIR, isTailwind4Entry, withWorktreeSources } from '../core/tailwind.js';
import { sessions } from './session.js';

/**
 * storyhub's webpack loader. Its output depends on live branch state, so it does not cache:
 *  - kind 'stories':  appends the branch story importers to builder-webpack5's storybook-stories.js
 *  - kind 'entry':    lets branch iframes load their worktree copy of dirty preview files
 *  - kind 'tailwind': adds the enabled worktrees to Tailwind 4 entry stylesheets as `@source`
 *    paths (other stylesheets pass through and stay cacheable)
 */
interface LoaderContext {
    getOptions(): { key: string; kind: 'stories' | 'entry' | 'tailwind' };
    cacheable(flag: boolean): void;
    resourcePath: string;
}

function tailwindCode(ctx: LoaderContext, source: string, key: string): string {
    const session = sessions().get(key);
    if (!session || !isTailwind4Entry(source, ctx.resourcePath)) return source;
    ctx.cacheable(false);
    // @tailwindcss/postcss detects sources from the working directory unless told otherwise
    const cwd = process.cwd();
    return withWorktreeSources(source, ctx.resourcePath, { gitRoot: session.gitRoot, base: cwd, worktrees: session.roots, cacheDir: join(cwd, CACHE_DIR) });
}

function entryCode(source: string, key: string): string {
    const session = sessions().get(key);
    const hub = session?.hub;
    const match = /const previewAnnotations = \[([\s\S]*?)\];/.exec(source);
    if (!hub || !match) return source;
    const overrides: string[] = [];
    for (const b of hub.branches.values()) {
        if (!b.previewOverrides.length) continue;
        const loaders: string[] = [];
        for (const m of match[1].matchAll(/require\('([^']+)'\)/g)) {
            const spec = m[1].replace(/\\\\/g, '\\');
            const rel = spec.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(spec) ? relInside(hub.root, realpath(spec)) : null;
            if (rel && b.previewOverrides.includes(rel)) loaders.push(`${JSON.stringify(m[1])}: () => require(${JSON.stringify(join(b.worktree.path, rel))})`);
        }
        if (loaders.length) overrides.push(`  ${JSON.stringify(b.worktree.id)}: { ${loaders.join(', ')} }`);
    }
    if (!overrides.length) return source;
    const wrapped = match[1].replace(/require\('([^']+)'\)/g, (_all, p: string) => `__storyhubRequire(${JSON.stringify(p)}, () => require('${p}'))`);
    const prelude = `
// --- storyhub: per-branch preview files ---
const __storyhubBranch = ${BRANCH_FROM_LOCATION};
const __storyhubPreviews = {
${overrides.join(',\n')}
};
const __storyhubRequire = (path, load) => {
  const override = __storyhubBranch && __storyhubPreviews[__storyhubBranch] && __storyhubPreviews[__storyhubBranch][path];
  return override ? override() : load();
};
`;
    return prelude + source.replace(match[0], `const previewAnnotations = [${wrapped}];`);
}

// webpack calls loaders with the loader context as `this`
function storyhubLoader(this: LoaderContext, source: string): string {
    const { key, kind } = this.getOptions();
    if (kind === 'tailwind') return tailwindCode(this, source, key);
    this.cacheable(false);
    if (kind === 'stories') return source + branchImportersCode(sessions().get(key)?.hub);
    return kind === 'entry' ? entryCode(source, key) : source;
}

export default storyhubLoader;
