import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git } from './git.js';
import { realpath } from './paths.js';

/**
 * Running Storybooks announce themselves so the CLI knows which checkout is the hub (it may be a
 * worktree, not the main checkout) and where to reach it. Records live in the repo's shared git
 * directory, one file per process, and are ignored once that process is gone.
 */
export interface ServerRecord {
    pid: number;
    /** Checkout Storybook runs from (the hub). */
    root: string;
    configDir: string;
    url: string;
    version: string;
    startedAt: string;
}

/** The repo's shared git directory (the same for every worktree). */
export async function gitCommonDir(cwd: string): Promise<string> {
    // relative (".git") from the main checkout, absolute from a linked worktree
    return realpath(resolve(cwd, (await git(cwd, ['rev-parse', '--git-common-dir'])).trim()));
}

const serversDir = (commonDir: string) => join(commonDir, 'storyhub', 'servers');

const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
    }
};

/** Writes this process's record and removes it on exit. Returns the cleanup function. */
export function registerServer(commonDir: string, record: Omit<ServerRecord, 'pid' | 'startedAt'>): () => void {
    const dir = serversDir(commonDir);
    const file = join(dir, `${process.pid}.json`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ ...record, pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
    const cleanup = () => {
        try {
            unlinkSync(file);
        } catch {
            // already gone
        }
    };
    process.once('exit', cleanup);
    return cleanup;
}

/** Records of Storybooks still running; records of dead processes are deleted. */
export function listServers(commonDir: string): ServerRecord[] {
    const dir = serversDir(commonDir);
    let files: string[];
    try {
        files = readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch {
        return [];
    }
    const out: ServerRecord[] = [];
    for (const f of files) {
        try {
            const rec = JSON.parse(readFileSync(join(dir, f), 'utf8')) as ServerRecord;
            if (typeof rec.pid === 'number' && alive(rec.pid)) out.push({ ...rec, root: realpath(rec.root) });
            else unlinkSync(join(dir, f));
        } catch {
            // unreadable record: skip
        }
    }
    return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
