import { existsSync } from 'node:fs';
import { git, gitTry } from './git.js';
import { realpath } from './paths.js';
import { EXCLUDE_KEY, INCLUDE_KEY, readSelection, unsetExact } from './selection.js';
import { gitCommonDir, listServers } from './servers.js';
import { type Batch, doom, ignoredNodeModules, putBack, recover, setAside, sweep, trashDir } from './trash.js';
import { parseWorktreeList } from './worktrees.js';

/**
 * Finds worktrees that are safe to remove, and removes them on request. Detection is read-only:
 * no objects or refs are written. Removal uses `git worktree remove` without --force, so git
 * itself refuses anything with local modifications, and branch deletion uses the safe `-d`.
 * Ignored node_modules are moved aside first and deleted in the background (see trash.ts).
 */

export interface CleanCandidate {
    path: string;
    branch: string | null;
    head: string;
    lastCommit: { date: string; subject: string; ageDays: number } | null;
    /** Why it can go (merged, squash-merged, stale). Empty means keep. */
    reasons: string[];
    /** Why it must stay even though it has reasons (uncommitted work, locked, unique commits). */
    blockers: string[];
    removable: boolean;
}

export interface CleanOptions {
    /** Ref branches are considered merged into. Default: origin/HEAD, else main, else master. */
    base?: string;
    /** Also treat worktrees whose last commit is older than this many days as candidates. */
    olderThanDays?: number;
}

export async function defaultBase(root: string): Promise<string> {
    const originHead = await gitTry(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    if (originHead?.trim()) return originHead.trim();
    for (const ref of ['main', 'master']) if (await gitTry(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`])) return ref;
    return 'HEAD';
}

/** How many worktrees are inspected at once. Each runs a few git processes, one after another. */
const CHECK_CONCURRENCY = 8;

/** Like Promise.all over `items.map(fn)`, in order, with at most `limit` calls in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = [];
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

async function lastCommit(root: string, rev: string) {
    const out = await gitTry(root, ['log', '-1', '--format=%cI%x00%s', rev]);
    if (!out) return null;
    const [date, subject] = out.trim().split('\0');
    return { date, subject, ageDays: Math.floor((Date.now() - Date.parse(date)) / 86_400_000) };
}

export async function findCleanupCandidates(cwd: string, opts: CleanOptions = {}): Promise<{ base: string; candidates: CleanCandidate[]; prunable: string[] }> {
    const entries = parseWorktreeList(await git(cwd, ['worktree', 'list', '--porcelain']));
    const main = entries[0]?.path ?? cwd; // git lists the main working tree first
    const base = opts.base ?? (await defaultBase(main));
    const prunable: string[] = [];
    const running = new Map(listServers(await gitCommonDir(main)).map(s => [s.root, s.url]));

    // commits on the base's mainline: a HEAD here never diverged (an idle branch or a detached
    // checkout of main), as opposed to a feature branch that was merged in from the side
    const mainline = new Set((await git(main, ['rev-list', '--first-parent', '--max-count=20000', base])).split('\n').filter(Boolean));

    const present = entries.slice(1).filter(e => {
        if (e.bare) return false;
        if (!e.prunable && existsSync(e.path)) return true;
        prunable.push(e.path);
        return false;
    });

    const candidates = await mapLimit(present, CHECK_CONCURRENCY, async (e): Promise<CleanCandidate> => {
        const reasons: string[] = [];
        const blockers: string[] = [];
        const commit = await lastCommit(main, e.head);

        const ancestor = (await gitTry(main, ['merge-base', '--is-ancestor', e.head, base])) !== null;
        if (ancestor) {
            reasons.push(mainline.has(e.head) ? `no commits of its own (sits on ${base})` : `merged into ${base}`);
        } else {
            const mb = (await gitTry(main, ['merge-base', base, e.head]))?.trim();
            if (mb) {
                const files = (await git(main, ['diff', '--name-only', '-z', mb, e.head])).split('\0').filter(Boolean);
                // every file the branch changed already matches the base: squash- or rebase-merged
                if (files.length && (await gitTry(main, ['diff', '--quiet', base, e.head, '--', ...files])) !== null) reasons.push(`changes already in ${base} (squash/rebase merged)`);
            }
        }
        if (opts.olderThanDays !== undefined && commit && commit.ageDays >= opts.olderThanDays) reasons.push(`last commit ${commit.ageDays} days ago`);

        const dirty = (await gitTry(e.path, ['status', '--porcelain']))?.trim();
        if (dirty) blockers.push(`uncommitted changes (${dirty.split('\n').length} path(s))`);
        if (e.locked) blockers.push('locked (git worktree unlock to allow removal)');
        if (running.has(realpath(e.path))) blockers.push(`Storybook is running from it (${running.get(realpath(e.path))})`);
        if (!e.branch && !ancestor && !reasons.some(r => r.startsWith('changes already'))) {
            // a detached HEAD's commits are only reachable from the worktree itself
            if ((await git(main, ['rev-list', '--count', e.head, `^${base}`])).trim() !== '0') blockers.push('detached HEAD with commits not in the base');
        }
        return { path: e.path, branch: e.branch, head: e.head, lastCommit: commit, reasons, blockers, removable: reasons.length > 0 && blockers.length === 0 };
    });
    return { base, candidates, prunable };
}

export interface CleanResult {
    removed: string[];
    deletedBranches: string[];
    kept: Array<{ path: string; error: string }>;
    pruned: boolean;
    /** Worktrees' worth of node_modules a background process is still deleting. */
    deletingInBackground: number;
}

export interface RemoveOptions {
    deleteBranches?: boolean;
    /** Called before each removal. */
    onProgress?: (candidate: CleanCandidate, index: number, total: number) => void;
}

/**
 * Moves a worktree's node_modules aside, unless git would refuse to remove the worktree anyway: it
 * may have been edited or locked since it was checked. Returns null when nothing was moved.
 */
async function setNodeModulesAside(main: string, trash: string, path: string): Promise<Batch | null> {
    const [status, list] = await Promise.all([gitTry(path, ['status', '--porcelain']), gitTry(main, ['worktree', 'list', '--porcelain'])]);
    const entry = parseWorktreeList(list ?? '').find(e => e.path === path);
    if (status === null || status.trim() || !entry || entry.locked) return null;
    return setAside(trash, path, await ignoredNodeModules(path));
}

export async function removeWorktrees(cwd: string, candidates: CleanCandidate[], opts: RemoveOptions = {}): Promise<CleanResult> {
    const entries = parseWorktreeList(await git(cwd, ['worktree', 'list', '--porcelain']));
    const main = entries[0]?.path ?? cwd;
    const result: CleanResult = { removed: [], deletedBranches: [], kept: [], pruned: false, deletingInBackground: 0 };
    const removable = candidates.filter(x => x.removable);
    const trash = trashDir(await gitCommonDir(main));
    const strand = (path: string, dir: string) => result.kept.push({ path, error: `node_modules could not be put back; it is in ${dir}` });
    for (const s of recover(trash)) strand(s.worktree, s.dir);
    const selection = await readSelection(main);
    const registered = [
        { key: INCLUDE_KEY, values: new Set(selection.include) },
        { key: EXCLUDE_KEY, values: new Set(selection.exclude) }
    ];
    for (const [i, c] of removable.entries()) {
        opts.onProgress?.(c, i, removable.length);
        const aside = await setNodeModulesAside(main, trash, c.path);
        try {
            await git(main, ['worktree', 'remove', c.path]);
            result.removed.push(c.path);
            if (aside) doom(aside);
        } catch (err) {
            result.kept.push({ path: c.path, error: (err as Error).message.split('\n').find(l => l.startsWith('fatal')) ?? 'git refused' });
            if (aside && !existsSync(c.path)) doom(aside);
            else if (aside && !putBack(aside)) strand(c.path, aside.dir);
            continue;
        }
        for (const { key, values } of registered) {
            const own = [c.branch, c.path].filter((v): v is string => v !== null && values.has(v));
            await unsetExact(main, key, own);
        }
        if (opts.deleteBranches && c.branch) {
            if ((await gitTry(main, ['branch', '-d', c.branch])) !== null) result.deletedBranches.push(c.branch);
            else result.kept.push({ path: c.branch, error: 'branch not deleted: git -d refused (not merged by ancestry; delete with git branch -D if intended)' });
        }
    }
    await git(main, ['worktree', 'prune']);
    result.pruned = true;
    result.deletingInBackground = sweep(trash);
    return result;
}
