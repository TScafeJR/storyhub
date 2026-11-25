import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { gitTry } from './git.js';
import { alive } from './servers.js';

/**
 * Deleting a node_modules is nearly all of the time `git worktree remove` takes, so clean renames
 * them into the shared git directory first and a detached process deletes them afterwards.
 *
 * A batch is `pending-*` from before the first rename until git has removed the worktree. Only then
 * does it become `doomed-*`, and only doomed batches are ever deleted. If git refuses the removal
 * the batch is put back; if clean is killed half way, the next run puts it back from the manifest.
 */
interface Manifest {
    pid: number;
    worktree: string;
    /** Paths relative to the worktree; entry i is stored in the batch as `i`. */
    entries: string[];
}

export interface Batch {
    dir: string;
    worktree: string;
    entries: string[];
}

/** What could not be put back, and where it is instead. */
export interface Stranded {
    worktree: string;
    dir: string;
}

const PENDING = 'pending-';
const DOOMED = 'doomed-';
const MANIFEST = 'manifest.json';

/** In the git directory so watchers and `git status` never see it, usually on the same volume. */
export const trashDir = (commonDir: string): string => join(commonDir, 'storyhub', 'trash');

const isRealDir = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;

const batches = (trash: string, prefix: string): string[] => {
    try {
        return readdirSync(trash)
            .filter(n => n.startsWith(prefix))
            .map(n => join(trash, n));
    } catch {
        return [];
    }
};

/** node_modules directories git ignores in full. Other ignored files are left for git to delete. */
export async function ignoredNodeModules(worktree: string): Promise<string[]> {
    const out = await gitTry(worktree, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
    return (out ?? '')
        .split('\0')
        .filter(p => p.endsWith('/')) // a symlink is listed without the slash
        .map(p => p.slice(0, -1))
        .filter(p => basename(p) === 'node_modules' && isRealDir(join(worktree, p)));
}

/** Renames `entries` out of the worktree. What cannot be renamed (another volume) stays in place. */
export function setAside(trash: string, worktree: string, entries: string[]): Batch | null {
    if (!entries.length) return null;
    const dir = join(trash, `${PENDING}${process.pid}-${randomUUID()}`);
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, MANIFEST), JSON.stringify({ pid: process.pid, worktree, entries } satisfies Manifest));
    } catch {
        return null;
    }
    let moved = 0;
    for (const [i, entry] of entries.entries()) {
        try {
            renameSync(join(worktree, entry), join(dir, String(i)));
            moved++;
        } catch {
            // stays in the worktree; git deletes it
        }
    }
    if (moved) return { dir, worktree, entries };
    rmSync(dir, { recursive: true, force: true });
    return null;
}

/** Puts a batch back. Never overwrites; returns false (keeping the batch) if anything is left. */
export function putBack(batch: Batch): boolean {
    let left = 0;
    for (const [i, entry] of batch.entries.entries()) {
        const stored = join(batch.dir, String(i));
        if (!existsSync(stored)) continue;
        const target = join(batch.worktree, entry);
        try {
            if (lstatSync(target, { throwIfNoEntry: false })) throw new Error('already there');
            mkdirSync(dirname(target), { recursive: true });
            renameSync(stored, target);
        } catch {
            left++;
        }
    }
    if (left) return false;
    rmSync(batch.dir, { recursive: true, force: true });
    return true;
}

/** Marks a batch for deletion: its worktree is gone. */
export function doom(batch: Batch): void {
    try {
        renameSync(batch.dir, join(dirname(batch.dir), `${DOOMED}${basename(batch.dir).slice(PENDING.length)}`));
    } catch {
        // still pending: the next run's recover() dooms it
    }
}

/** Settles batches left by a clean that was killed between setting aside and removing. */
export function recover(trash: string): Stranded[] {
    const stranded: Stranded[] = [];
    for (const dir of batches(trash, PENDING)) {
        let manifest: Manifest;
        try {
            manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as Manifest;
        } catch {
            continue; // unknown contents: never delete
        }
        if (alive(manifest.pid)) continue;
        const batch: Batch = { dir, worktree: manifest.worktree, entries: manifest.entries };
        if (!existsSync(batch.worktree)) doom(batch);
        else if (!putBack(batch)) stranded.push({ worktree: batch.worktree, dir });
    }
    return stranded;
}

const SWEEP = `const { rmSync } = require('node:fs');
for (const dir of process.argv.slice(1)) try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}`;

/** Deletes doomed batches (this run's and interrupted ones) in a process that outlives the CLI. Returns how many. */
export function sweep(trash: string): number {
    const doomed = batches(trash, DOOMED);
    if (!doomed.length) return 0;
    try {
        // cwd: the caller's may be a worktree that was just removed
        const child = spawn(process.execPath, ['-e', SWEEP, ...doomed], { cwd: trash, detached: true, stdio: 'ignore', windowsHide: true });
        child.on('error', () => undefined); // left for the next run
        child.unref();
    } catch {
        return 0;
    }
    return doomed.length;
}
