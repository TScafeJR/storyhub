import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { git } from './git.js';
import { realpath, sanitizeId } from './paths.js';
import type { Worktree } from './types.js';

/** Absolute, real path of the git working tree that contains `cwd`. */
export async function gitToplevel(cwd: string): Promise<string> {
    return realpath((await git(cwd, ['rev-parse', '--show-toplevel'])).trim());
}

export function parseWorktreeList(porcelain: string): Array<{ path: string; head: string; branch: string | null; bare: boolean; prunable: boolean }> {
    const out: Array<{ path: string; head: string; branch: string | null; bare: boolean; prunable: boolean }> = [];
    for (const block of porcelain.split(/\n\n+/)) {
        const lines = block.split('\n').filter(Boolean);
        if (!lines.length) continue;
        const entry = { path: '', head: '', branch: null as string | null, bare: false, prunable: false };
        for (const line of lines) {
            const [key, ...rest] = line.split(' ');
            const value = rest.join(' ');
            if (key === 'worktree') entry.path = value;
            else if (key === 'HEAD') entry.head = value;
            else if (key === 'branch') entry.branch = value.replace(/^refs\/heads\//, '');
            else if (key === 'bare') entry.bare = true;
            else if (key === 'prunable') entry.prunable = true;
        }
        if (entry.path) out.push(entry);
    }
    return out;
}

/** Lists the repo's usable worktrees; the one at `hubRoot` is flagged as the hub. */
export async function listWorktrees(hubRoot: string): Promise<Worktree[]> {
    const hub = realpath(hubRoot);
    const entries = parseWorktreeList(await git(hub, ['worktree', 'list', '--porcelain']));
    const used = new Set<string>();
    const result: Worktree[] = [];
    for (const e of entries) {
        if (e.bare || e.prunable || !existsSync(e.path)) continue;
        const path = realpath(e.path);
        const isHub = path === hub;
        let id = sanitizeId(e.branch ?? basename(path));
        for (let n = 2; used.has(id); n++) id = `${sanitizeId(e.branch ?? basename(path))}-${n}`;
        used.add(id);
        result.push({ id, path, head: e.head, branch: e.branch, isHub });
    }
    return result;
}
