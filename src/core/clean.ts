import { existsSync } from 'node:fs';
import { git, gitTry } from './git.js';
import { realpath } from './paths.js';
import { EXCLUDE_KEY, INCLUDE_KEY } from './selection.js';
import { gitCommonDir, listServers } from './servers.js';
import { parseWorktreeList } from './worktrees.js';

/**
 * Finds worktrees that are safe to remove, and removes them on request. Detection is read-only:
 * no objects or refs are written. Removal uses `git worktree remove` without --force, so git
 * itself refuses anything with local modifications, and branch deletion uses the safe `-d`.
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
    const candidates: CleanCandidate[] = [];
    const prunable: string[] = [];
    const running = new Map(listServers(await gitCommonDir(main)).map(s => [s.root, s.url]));

    // commits on the base's mainline: a HEAD here never diverged (an idle branch or a detached
    // checkout of main), as opposed to a feature branch that was merged in from the side
    const mainline = new Set((await git(main, ['rev-list', '--first-parent', '--max-count=20000', base])).split('\n').filter(Boolean));

    for (const e of entries.slice(1)) {
        if (e.bare) continue;
        if (e.prunable || !existsSync(e.path)) {
            prunable.push(e.path);
            continue;
        }
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
        candidates.push({ path: e.path, branch: e.branch, head: e.head, lastCommit: commit, reasons, blockers, removable: reasons.length > 0 && blockers.length === 0 });
    }
    return { base, candidates, prunable };
}

export interface CleanResult {
    removed: string[];
    deletedBranches: string[];
    kept: Array<{ path: string; error: string }>;
    pruned: boolean;
}

export async function removeWorktrees(cwd: string, candidates: CleanCandidate[], opts: { deleteBranches?: boolean } = {}): Promise<CleanResult> {
    const entries = parseWorktreeList(await git(cwd, ['worktree', 'list', '--porcelain']));
    const main = entries[0]?.path ?? cwd;
    const result: CleanResult = { removed: [], deletedBranches: [], kept: [], pruned: false };
    for (const c of candidates.filter(x => x.removable)) {
        try {
            await git(main, ['worktree', 'remove', c.path]);
            result.removed.push(c.path);
        } catch (err) {
            result.kept.push({ path: c.path, error: (err as Error).message.split('\n').find(l => l.startsWith('fatal')) ?? 'git refused' });
            continue;
        }
        for (const key of [INCLUDE_KEY, EXCLUDE_KEY]) {
            for (const v of [c.branch, c.path].filter(Boolean) as string[]) await gitTry(main, ['config', '--unset-all', key, `^${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`]);
        }
        if (opts.deleteBranches && c.branch) {
            if ((await gitTry(main, ['branch', '-d', c.branch])) !== null) result.deletedBranches.push(c.branch);
            else result.kept.push({ path: c.branch, error: 'branch not deleted: git -d refused (not merged by ancestry; delete with git branch -D if intended)' });
        }
    }
    await git(main, ['worktree', 'prune']);
    result.pruned = true;
    return result;
}
