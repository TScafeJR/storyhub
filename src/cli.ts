#!/usr/bin/env node
import { classifyDrift, mergeBase, workingChanges } from './core/diff.js';
import { git } from './core/git.js';
import { gitToplevel, listWorktrees } from './core/worktrees.js';

const HELP = `storyhub: git worktrees as branch sections in one Storybook

Usage:
  storyhub status [--url http://localhost:6006] [--json]
      Branch summary from the running Storybook (affected stories, drift).
      Falls back to a git-only summary (changed files, drift) when no server answers.
  storyhub doctor
      Checks this checkout for what storyhub needs.
`;

const args = process.argv.slice(2);
const flag = (name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
};

async function status() {
    const url = (flag('--url') ?? 'http://localhost:6006').replace(/\/$/, '');
    const asJson = args.includes('--json');
    let branches: Array<Record<string, unknown>> | null = null;
    try {
        const r = await fetch(`${url}/__storyhub/branches.json`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) branches = (await r.json()).branches;
    } catch {
        branches = null;
    }
    let source = 'server';
    if (!branches) {
        source = 'git';
        const root = await gitToplevel(process.cwd());
        const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
        branches = [];
        for (const wt of await listWorktrees(root)) {
            if (wt.isHub) continue;
            const base = await mergeBase(root, head, wt.head);
            const changes = base ? await workingChanges(wt.path, base) : [];
            branches.push({ id: wt.id, branch: wt.branch, path: wt.path, changedFiles: changes.length, drift: classifyDrift(changes, null, []), affectedStories: null });
        }
    }
    if (asJson) return console.log(JSON.stringify({ source, branches }, null, 2));
    if (!branches.length) return console.log('No other worktrees. Create one with `git worktree add <path> <branch>`.');
    console.log(source === 'server' ? `From ${url}:` : 'Storybook not reachable; git-only summary:');
    for (const b of branches) {
        const drift = (b.drift as string[]).length ? `  [${(b.drift as string[]).join(', ')}]` : '';
        const stories = b.affectedStories === null ? '' : `, ${b.affectedStories} affected stor${b.affectedStories === 1 ? 'y' : 'ies'}`;
        console.log(`  ${b.id}: ${b.changedFiles} changed file(s)${stories}${drift}${b.error ? `  error: ${b.error}` : ''}`);
    }
}

async function doctor() {
    const checks: Array<[string, boolean, string]> = [];
    let root = '';
    try {
        root = await gitToplevel(process.cwd());
        checks.push(['git checkout', true, root]);
    } catch {
        checks.push(['git checkout', false, 'run inside a git repository']);
    }
    if (root) {
        const wts = await listWorktrees(root);
        checks.push(['other worktrees', wts.length > 1, wts.length > 1 ? `${wts.length - 1} found` : 'none yet; `git worktree add ../my-feature -b my-feature`']);
    }
    try {
        const { createRequire } = await import('node:module');
        const req = createRequire(`${process.cwd()}/`);
        const sb = req('storybook/package.json').version as string;
        checks.push(['storybook >= 10.5', Number(sb.split('.')[0]) > 10 || (sb.startsWith('10.') && Number(sb.split('.')[1]) >= 5), sb]);
        try {
            checks.push(['vite builder', true, req('@storybook/builder-vite/package.json').version]);
        } catch {
            checks.push(['vite builder', false, 'storyhub v0.1 supports Vite-based Storybook frameworks only']);
        }
    } catch {
        checks.push(['storybook installed', false, 'run from the package that has Storybook installed']);
    }
    for (const [name, ok, detail] of checks) console.log(`${ok ? '✓' : '✗'} ${name}: ${detail}`);
    if (checks.some(c => !c[1])) process.exitCode = 1;
}

const cmd = args[0];
if (cmd === 'status') await status();
else if (cmd === 'doctor') await doctor();
else console.log(HELP);
