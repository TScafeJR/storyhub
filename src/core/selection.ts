import { basename } from 'node:path';
import { git, gitTry } from './git.js';
import type { Worktree } from './types.js';

/**
 * Which worktrees become branch sections. Selection is opt-in by default: a worktree shows up only
 * when an include pattern matches it (and no exclude pattern does).
 *
 * Patterns come from two places and are merged:
 *  - addon options in .storybook/main (committed, team-wide), and
 *  - local git config, multi-valued `storyhub.include` / `storyhub.exclude` in the repo's shared
 *    .git/config (never committed, visible to every worktree). The UI, CLI and MCP tool write here.
 *
 * A pattern matches a worktree's branch name (`feat/login`), its storyhub id (`feat-login`), its
 * directory name or its absolute path. `*` matches any run of characters, including `/`.
 */
export type SelectionMode = 'opt-in' | 'all';

export interface SelectionOptions {
    mode?: SelectionMode;
    include?: string[];
    exclude?: string[];
}

export interface Selection {
    mode: SelectionMode;
    include: string[];
    exclude: string[];
}

export const INCLUDE_KEY = 'storyhub.include';
export const EXCLUDE_KEY = 'storyhub.exclude';

const getAll = async (root: string, key: string): Promise<string[]> =>
    ((await gitTry(root, ['config', '--get-all', key])) ?? '')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);

export async function readSelection(root: string, opts: SelectionOptions = {}): Promise<Selection> {
    const [include, exclude] = await Promise.all([getAll(root, INCLUDE_KEY), getAll(root, EXCLUDE_KEY)]);
    return {
        mode: opts.mode ?? 'opt-in',
        include: [...(opts.include ?? []), ...include],
        exclude: [...(opts.exclude ?? []), ...exclude]
    };
}

const globToRegExp = (pattern: string) => new RegExp(`^${pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

export function matches(wt: Worktree, pattern: string): boolean {
    const re = globToRegExp(pattern.trim());
    return [wt.branch, wt.id, basename(wt.path), wt.path].some(v => v != null && re.test(v));
}

export function isSelected(wt: Worktree, sel: Selection): boolean {
    if (wt.isHub) return false;
    if (sel.exclude.some(p => matches(wt, p))) return false;
    return sel.mode === 'all' || sel.include.some(p => matches(wt, p));
}

/** The value written to git config for a worktree: its branch, or its path when detached. */
export const selectionValue = (wt: Worktree): string => wt.branch ?? wt.path;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function unsetExact(root: string, key: string, values: string[]): Promise<void> {
    for (const v of values) await gitTry(root, ['config', '--unset-all', key, `^${escapeRegex(v)}$`]);
}

/**
 * Turns a worktree on or off by editing local git config, keeping patterns from main.ts intact:
 * selecting removes matching excludes and adds an include if nothing matches yet; deselecting
 * removes exact includes and adds an exclude when a glob or mode 'all' would still match.
 */
export async function setSelected(root: string, wt: Worktree, selected: boolean, opts: SelectionOptions = {}): Promise<boolean> {
    const exact = [selectionValue(wt), wt.id, wt.path, basename(wt.path)].filter((v, i, a) => v && a.indexOf(v) === i) as string[];
    if (selected) {
        await unsetExact(root, EXCLUDE_KEY, exact);
        let sel = await readSelection(root, opts);
        if (!isSelected(wt, sel) && !sel.exclude.some(p => matches(wt, p))) {
            await git(root, ['config', '--add', INCLUDE_KEY, selectionValue(wt)]);
            sel = await readSelection(root, opts);
        }
        return isSelected(wt, sel);
    }
    await unsetExact(root, INCLUDE_KEY, exact);
    const sel = await readSelection(root, opts);
    if (isSelected(wt, sel)) await git(root, ['config', '--add', EXCLUDE_KEY, selectionValue(wt)]);
    return isSelected(wt, await readSelection(root, opts));
}
