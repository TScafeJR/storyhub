import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { realpath, relInside, toPosix } from './paths.js';

/**
 * Tailwind generates CSS by scanning source files, and the hub's stylesheet only scans the hub.
 * A class used only in a branch would never be generated, so branch stories render unstyled.
 * These helpers point Tailwind at the worktrees too:
 *  - Tailwind 4 reads extra paths from the stylesheet (`@source`), so storyhub imports them.
 *  - Tailwind 3 only reads them from its config, so `withStoryhub` (storyhub/tailwind) adds them.
 */

/** Set by storyhub's preset in a dev Storybook; `withStoryhub` does nothing without it. */
export const ROOT_ENV = 'STORYHUB_ROOT';

/** Where generated stylesheets go, relative to the project root. */
export const CACHE_DIR = 'node_modules/.cache/storyhub';

/** Imports or directives that make a stylesheet a Tailwind entry. */
const TAILWIND_ENTRY = /@import\s+(['"])tailwindcss(?:\/[^'"]*)?\1|@tailwind\s+utilities\b/;
/** Syntax only Tailwind 4 understands, used when the installed version cannot be read. */
const V4_ONLY = /@import\s+(['"])tailwindcss\1|@(?:theme|source|utility|custom-variant|plugin)\b/;

const majors = new Map<string, number | null>();

/** Major version of the tailwindcss package that `file` would import, or null if none resolves. */
export function tailwindMajor(file: string): number | null {
    const dir = dirname(file);
    if (majors.has(dir)) return majors.get(dir)!;
    let major: number | null = null;
    try {
        const pkg = createRequire(file).resolve('tailwindcss/package.json');
        major = Number(String(JSON.parse(readFileSync(pkg, 'utf8')).version).split('.')[0]) || null;
    } catch {
        major = null;
    }
    majors.set(dir, major);
    return major;
}

/** True when `css` is a Tailwind 4 entry stylesheet (Tailwind 3 stylesheets are left alone). */
export function isTailwind4Entry(css: string, file: string): boolean {
    if (!TAILWIND_ENTRY.test(css)) return false;
    const major = tailwindMajor(file);
    return major === null ? V4_ONLY.test(css) : major >= 4;
}

export interface MirrorOptions {
    /** The hub checkout's git root. */
    gitRoot: string;
    /** Directory relative paths are resolved against. */
    base: string;
    /** Worktree roots to mirror into. */
    worktrees: string[];
}

/** `path` (absolute, may be a glob) as the same location inside each worktree. */
function mirror(path: string, opts: MirrorOptions): string[] {
    const root = realpath(opts.gitRoot);
    const rel = path === root ? '' : relInside(root, path);
    if (rel === null) return [];
    return opts.worktrees.map(wt => toPosix(join(wt, rel)));
}

/**
 * `@source` lines that make a Tailwind 4 stylesheet also scan each worktree: its automatic
 * detection root (the project root, or the dir given with `source("…")`) and any explicit
 * `@source` paths, mapped into every worktree. Empty when there is nothing to add.
 */
export function worktreeSources(css: string, file: string, opts: MirrorOptions): string {
    if (!opts.worktrees.length) return '';
    const dir = realpath(dirname(file));
    const paths: string[] = [];
    // `source(none)` turns automatic detection off; `source("dir")` moves its root
    const importSource = /@import\s+(['"])tailwindcss\1[^;]*?\bsource\(\s*(none|(['"])(.*?)\3)\s*\)/.exec(css);
    if (!importSource) paths.push(realpath(opts.base));
    else if (importSource[2] !== 'none') paths.push(resolve(dir, importSource[4]));
    for (const m of css.matchAll(/@source\s+(['"])(.*?)\1/g)) paths.push(resolve(dir, m[2]));
    const lines = new Set<string>();
    for (const p of paths) for (const target of mirror(p, opts)) lines.add(`@source ${JSON.stringify(target)};`);
    return lines.size ? `\n${[...lines].join('\n')}\n` : '';
}

/**
 * The stylesheet with an `@import` of a generated file that holds its worktree `@source` lines.
 *
 * The lines live in a file rather than inline because Tailwind 4 reuses a compiled stylesheet
 * until one of its file dependencies gets a newer mtime; it does not notice changed input text.
 * The file is imported even while no branch is on, so it is a dependency from the first build,
 * and it is rewritten (only) when its lines change, which makes Tailwind rebuild on its own terms.
 */
export function withWorktreeSources(css: string, file: string, opts: MirrorOptions & { cacheDir: string }): string {
    const generated = join(opts.cacheDir, `tailwind-${createHash('sha1').update(file).digest('hex').slice(0, 12)}.css`);
    const content = `/* storyhub: worktree sources for ${toPosix(file)} */\n${worktreeSources(css, file, opts).trim()}\n`;
    let current: string | null = null;
    try {
        current = readFileSync(generated, 'utf8');
    } catch {
        current = null;
    }
    if (current !== content) {
        mkdirSync(opts.cacheDir, { recursive: true });
        writeFileSync(generated, content);
    }
    const line = `@import ${JSON.stringify(toPosix(generated))};\n`;
    // @import must come first; only @charset may precede it
    const charset = /^@charset\s+(['"]).*?\1;\s*/.exec(css);
    return charset ? charset[0] + line + css.slice(charset[0].length) : line + css;
}

/**
 * Tailwind 3 `content` globs (relative to `base`, or absolute) mapped into every worktree.
 * Negated globs (`!…`) stay negated; globs outside the git root are skipped.
 */
export function mirrorContentGlobs(globs: string[], opts: MirrorOptions): string[] {
    const base = realpath(opts.base);
    const out: string[] = [];
    for (const glob of globs) {
        const negated = glob.startsWith('!');
        const body = negated ? glob.slice(1) : glob;
        for (const target of mirror(resolve(base, body), opts)) out.push(negated ? `!${target}` : target);
    }
    return out;
}
