import { git, gitTry } from './git.js';
import type { ChangeKind, DriftFlag, FileChange } from './types.js';

const LOCKFILES = new Set(['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json']);

function parseNameStatus(out: string): FileChange[] {
    // -z output: STATUS\0path\0STATUS\0path\0 ...
    const parts = out.split('\0').filter(Boolean);
    const changes: FileChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
        const status = parts[i][0];
        const kind: ChangeKind = status === 'A' ? 'A' : status === 'D' ? 'D' : 'M';
        changes.push({ rel: parts[i + 1], kind });
    }
    return changes;
}

async function untracked(cwd: string): Promise<string[]> {
    return (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
}

export async function mergeBase(hubRoot: string, a: string, b: string): Promise<string | null> {
    const out = await gitTry(hubRoot, ['merge-base', a, b]);
    return out ? out.trim() : null;
}

/** Files that differ between `base` and the working tree at `cwd`, including untracked files. */
export async function workingChanges(cwd: string, base: string): Promise<FileChange[]> {
    const tracked = parseNameStatus(await git(cwd, ['diff', '--name-status', '--no-renames', '-z', base]));
    const seen = new Set(tracked.map(c => c.rel));
    for (const rel of await untracked(cwd)) if (!seen.has(rel)) tracked.push({ rel, kind: 'A' });
    return tracked.sort((x, y) => x.rel.localeCompare(y.rel));
}

export function classifyDrift(changes: FileChange[], configDirRel: string | null, diverged: string[]): DriftFlag[] {
    const flags = new Set<DriftFlag>();
    const configPrefix = configDirRel ? `${configDirRel.replace(/\/$/, '')}/` : null;
    for (const { rel } of changes) {
        const base = rel.split('/').pop() ?? rel;
        if (LOCKFILES.has(base)) flags.add('deps-drift');
        if (configPrefix && rel.startsWith(configPrefix)) flags.add('config-drift');
    }
    if (diverged.length) flags.add('diverged');
    return [...flags];
}
