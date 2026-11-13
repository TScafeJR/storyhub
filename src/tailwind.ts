import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath } from './core/paths.js';
import { mirrorContentGlobs, ROOT_ENV } from './core/tailwind.js';
import { parseWorktreeList } from './core/worktrees.js';

export interface WithStoryhubOptions {
    /**
     * Directory your relative `content` globs are resolved from. Defaults to the working
     * directory, which is what Tailwind uses; pass your config's directory if you set
     * `content.relative: true`.
     */
    base?: string;
}

type Content = Array<string | Record<string, unknown>>;

/** Every linked worktree of the repo at `gitRoot`, except that checkout itself. */
function linkedWorktrees(gitRoot: string): string[] {
    let porcelain: string;
    try {
        porcelain = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: gitRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
        return [];
    }
    const hub = realpath(gitRoot);
    return parseWorktreeList(porcelain)
        .filter(e => !e.bare && !e.prunable && existsSync(e.path))
        .map(e => realpath(e.path))
        .filter(p => p !== hub);
}

/**
 * Wraps a Tailwind 3 config so a storyhub Storybook also scans your worktrees, and classes used
 * only in a branch get generated. Outside storyhub's dev Storybook it returns the config as is,
 * so app builds and other tools are unaffected.
 *
 * Every worktree of the repo is scanned, not only the ones that are on: Tailwind 3 reads its
 * config once, so turning a branch on later would otherwise need a restart. The extra classes
 * only reach Storybook's dev CSS.
 *
 * ```ts
 * // tailwind.config.ts
 * import { withStoryhub } from 'storyhub/tailwind';
 * export default withStoryhub({ content: [...yourGlobs], theme: {} });
 * ```
 *
 * Tailwind 4 needs no setup: storyhub adds the worktrees to your stylesheet's sources itself.
 */
export function withStoryhub<T extends object>(config: T, options: WithStoryhubOptions = {}): T {
    const gitRoot = process.env[ROOT_ENV];
    if (!gitRoot) return config;
    const worktrees = linkedWorktrees(gitRoot);
    if (!worktrees.length) return config;
    const opts = { gitRoot, base: options.base ?? process.cwd(), worktrees };
    const extend = (entries: Content): Content => [...entries, ...mirrorContentGlobs(entries.filter((e): e is string => typeof e === 'string'), opts)];
    const content = (config as { content?: unknown }).content;
    if (Array.isArray(content)) return { ...config, content: extend(content as Content) };
    if (content && typeof content === 'object' && Array.isArray((content as { files?: unknown }).files)) {
        const files = (content as { files: Content }).files;
        return { ...config, content: { ...content, files: extend(files) } };
    }
    return config;
}
