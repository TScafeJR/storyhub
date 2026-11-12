#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { findCleanupCandidates, removeWorktrees } from './core/clean.js';
import { classifyDrift, mergeBase, workingChanges } from './core/diff.js';
import { git, gitTry } from './core/git.js';
import { realpath } from './core/paths.js';
import { EXCLUDE_KEY, INCLUDE_KEY, isSelected, matches, readSelection, setSelected } from './core/selection.js';
import { gitCommonDir, listServers, type ServerRecord } from './core/servers.js';
import type { Worktree } from './core/types.js';
import { gitToplevel, listWorktrees, parseWorktreeList } from './core/worktrees.js';

const HELP = `storyhub: your git worktrees as branch sections in one Storybook

Choosing branches (opt-in; stored in this repo's local git config, never committed):
  storyhub on [target...]     Show worktrees in Storybook. No target = the worktree you are in.
                              Any checkout can run Storybook; list marks it ★ hub.
  storyhub off [target...]    Hide them again. No target = the worktree you are in.
  storyhub list [--json]      Every worktree and whether it is on.
      A target is a branch (feat/login), a worktree id or directory name, a path, or a glob
      ('feat/*'). A glob is saved as a pattern, so future worktrees that match are on too.

Cleaning up:
  storyhub clean [--base <ref>] [--older-than <days>] [--delete-branches] [--yes] [--json]
      Lists worktrees whose branches are merged (or squash-merged) into the base, or older than
      --older-than days. Nothing is removed without --yes; worktrees with uncommitted changes,
      locked ones and detached HEADs with unmerged commits are always kept. --delete-branches
      also deletes merged branches with git branch -d.

Inspecting:
  storyhub status [--url <url>] [--json]
      Branch summary from the running Storybook (found automatically), or git-only.
  storyhub doctor [-c <dir>]  Checks this package and checkout for what storyhub needs.
  storyhub --version
`;

const version: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i === -1 ? undefined : rest[i + 1];
};
const has = (name: string) => rest.includes(name);
const positional = () => {
    const out: string[] = [];
    for (let i = 0; i < rest.length; i++) {
        if (rest[i].startsWith('--')) {
            if (['--base', '--older-than', '--url', '--config-dir'].includes(rest[i])) i++;
            continue;
        }
        out.push(rest[i]);
    }
    return out;
};

/**
 * The repo's worktrees. `isHub` marks checkouts a Storybook is running from right now (found via
 * the records running Storybooks leave in the shared git directory), not the main checkout.
 */
async function repoWorktrees(): Promise<{ main: string; here: string; worktrees: Worktree[]; servers: ServerRecord[] }> {
    const here = await gitToplevel(process.cwd());
    const main = realpath(parseWorktreeList(await git(here, ['worktree', 'list', '--porcelain']))[0]?.path ?? here);
    const servers = listServers(await gitCommonDir(here));
    const hubs = new Set(servers.map(s => s.root));
    const worktrees = (await listWorktrees(main)).map(w => ({ ...w, isHub: hubs.has(w.path) }));
    return { main, here, worktrees, servers };
}

const serverFor = (servers: ServerRecord[], root: string) => servers.find(s => s.root === root);

async function toggle(on: boolean) {
    const { main, here, worktrees, servers } = await repoWorktrees();
    const targets = positional();
    if (!targets.length) {
        const wt = worktrees.find(w => w.path === here);
        if (wt?.isHub) {
            console.error(`storyhub: Storybook is running from this checkout (${serverFor(servers, here)?.url}), so its stories are already the Common section. Run this inside another worktree, or name one: storyhub ${cmd} <branch>`);
            process.exitCode = 1;
            return;
        }
        if (!wt) {
            console.error(`storyhub: ${here} is not a worktree of this repo.`);
            process.exitCode = 1;
            return;
        }
        targets.push(wt.branch ?? wt.path);
    }
    for (const target of targets) {
        if (target.includes('*')) {
            if (on) {
                await gitTry(main, ['config', '--unset-all', EXCLUDE_KEY, `^${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`]);
                await git(main, ['config', '--add', INCLUDE_KEY, target]);
            } else {
                const removed = await gitTry(main, ['config', '--unset-all', INCLUDE_KEY, `^${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`]);
                if (removed === null) await git(main, ['config', '--add', EXCLUDE_KEY, target]);
            }
            const hit = worktrees.filter(w => !w.isHub && matches(w, target));
            console.log(`${on ? 'on ' : 'off'}  pattern ${target}${hit.length ? ` (matches ${hit.map(w => w.branch ?? basename(w.path)).join(', ')})` : ' (no worktree matches yet)'}`);
            continue;
        }
        const hit = worktrees.filter(w => !w.isHub && matches(w, target));
        if (!hit.length) {
            if (on) {
                // allow opting in a branch before its worktree exists
                await git(main, ['config', '--add', INCLUDE_KEY, target]);
                console.log(`on   ${target} (no worktree yet; it will show up once one exists)`);
            } else {
                console.error(`storyhub: no worktree matches "${target}". See storyhub list.`);
                process.exitCode = 1;
            }
            continue;
        }
        for (const wt of hit) {
            const now = await setSelected(main, wt, on);
            console.log(`${now ? 'on ' : 'off'}  ${wt.branch ?? '(detached)'}  ${wt.path}`);
        }
    }
}

async function list() {
    const { main, worktrees, servers } = await repoWorktrees();
    const sel = await readSelection(main);
    const rows = await Promise.all(
        worktrees.map(async wt => {
            const log = (await gitTry(main, ['log', '-1', '--format=%cr%x00%s', wt.head]))?.trim().split('\0') ?? [];
            return {
                id: wt.id,
                branch: wt.branch,
                path: wt.path,
                main: wt.path === main,
                storybook: wt.isHub ? (serverFor(servers, wt.path)?.url ?? true) : false,
                on: isSelected(wt, sel),
                lastCommit: log[0] ?? null,
                subject: log[1] ?? null
            };
        })
    );
    if (has('--json')) return console.log(JSON.stringify({ mode: sel.mode, include: sel.include, exclude: sel.exclude, servers, worktrees: rows }, null, 2));
    for (const r of rows) {
        const mark = r.storybook ? '★ hub ' : r.on ? '● on  ' : '○ off ';
        console.log(`${mark}  ${(r.branch ?? '(detached)').padEnd(40)}  ${(r.lastCommit ?? '').padEnd(16)}  ${r.path}${r.main ? '  (main checkout)' : ''}`);
    }
    if (servers.length) for (const s of servers) console.log(`\n★ Storybook is running from ${s.root} at ${s.url}; its stories are the Common section.`);
    else console.log('\nStorybook is not running. Whichever checkout you start it from becomes the Common section.');
    if (sel.include.length || sel.exclude.length) console.log(`\npatterns: include [${sel.include.join(', ')}]  exclude [${sel.exclude.join(', ')}]`);
    if (!rows.some(r => r.on)) console.log('\nNothing is on yet. Inside a worktree run `storyhub on`, or `storyhub on <branch>`.');
}

async function clean() {
    const olderThan = flag('--older-than');
    const report = await findCleanupCandidates(process.cwd(), { base: flag('--base'), olderThanDays: olderThan === undefined ? undefined : Number(olderThan) });
    const yes = has('--yes');
    const result = yes ? await removeWorktrees(process.cwd(), report.candidates, { deleteBranches: has('--delete-branches') }) : null;
    if (has('--json')) return console.log(JSON.stringify({ ...report, result }, null, 2));
    const removable = report.candidates.filter(c => c.removable);
    console.log(`Base: ${report.base}`);
    for (const c of report.candidates.filter(x => x.reasons.length)) {
        const verdict = c.removable ? (yes ? (result!.removed.includes(c.path) ? 'removed' : 'kept   ') : 'remove ') : 'keep   ';
        console.log(`  ${verdict}  ${c.branch ?? '(detached)'}  ${c.path}\n           ${[...c.reasons, ...c.blockers.map(b => `blocked: ${b}`)].join('; ')}`);
    }
    if (report.prunable.length) console.log(`  ${yes ? 'pruned ' : 'prune  '}  ${report.prunable.length} worktree record(s) whose directory is gone`);
    for (const k of result?.kept ?? []) console.log(`  note: ${k.path}: ${k.error}`);
    if (result?.deletedBranches.length) console.log(`  deleted branches: ${result.deletedBranches.join(', ')}`);
    if (!removable.length && !report.prunable.length) console.log('  Nothing to clean.');
    else if (!yes) console.log(`\nDry run. Re-run with --yes to remove ${removable.length} worktree(s)${has('--delete-branches') ? ' and delete their merged branches' : ''}.`);
}

async function status() {
    // prefer the Storybook this checkout belongs to: the one running from here, else the first found
    let detected: ServerRecord | undefined;
    try {
        const { here, servers } = await repoWorktrees();
        detected = serverFor(servers, here) ?? servers[0];
    } catch {
        detected = undefined;
    }
    const url = (flag('--url') ?? detected?.url ?? 'http://localhost:6006').replace(/\/$/, '');
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
        const { main, worktrees } = await repoWorktrees();
        const sel = await readSelection(main);
        const head = (await git(main, ['rev-parse', 'HEAD'])).trim();
        branches = [];
        for (const wt of worktrees.filter(w => isSelected(w, sel))) {
            const base = await mergeBase(main, head, wt.head);
            const changes = base ? await workingChanges(wt.path, base) : [];
            branches.push({ id: wt.id, branch: wt.branch, path: wt.path, changedFiles: changes.length, drift: classifyDrift(changes, null, []), affectedStories: null });
        }
    }
    if (has('--json')) return console.log(JSON.stringify({ source, branches }, null, 2));
    if (!branches.length) return console.log('No branches are on. Inside a worktree run `storyhub on`.');
    console.log(source === 'server' ? `From ${url}:` : 'Storybook not reachable; git-only summary:');
    for (const b of branches) {
        const drift = (b.drift as string[]).length ? `  [${(b.drift as string[]).join(', ')}]` : '';
        const stories = b.affectedStories === null ? '' : `, ${b.affectedStories} affected stor${b.affectedStories === 1 ? 'y' : 'ies'}`;
        console.log(`  ${b.id}: ${b.changedFiles} changed file(s)${stories}${drift}${b.error ? `  error: ${b.error}` : ''}`);
    }
}

async function doctor() {
    const checks: Array<[string, boolean, string]> = [];
    const cwd = process.cwd();
    checks.push(['storyhub', true, version]);
    let root = '';
    try {
        root = await gitToplevel(cwd);
        checks.push(['git checkout', true, root]);
    } catch {
        checks.push(['git checkout', false, 'run inside a git repository']);
    }
    if (root) {
        const { main, worktrees, servers } = await repoWorktrees();
        const sel = await readSelection(main);
        const on = worktrees.filter(w => isSelected(w, sel)).length;
        checks.push(['storybook running', true, servers.length ? servers.map(s => `${s.url} from ${s.root}`).join('; ') : 'not running (informational)']);
        checks.push(['other worktrees', worktrees.length > 1, worktrees.length > 1 ? `${worktrees.length - 1} found, ${on} on` : 'none yet; `git worktree add ../my-feature -b my-feature`']);
    }
    const { createRequire } = await import('node:module');
    const req = createRequire(`${cwd}/`);
    let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
    try {
        pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    } catch {
        // no package.json here; the checks below report what is missing
    }
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    try {
        const sb = req('storybook/package.json').version as string;
        const [major, minor] = sb.split('.').map(Number);
        checks.push(['storybook >= 10.5', major > 10 || (major === 10 && minor >= 5), sb]);
    } catch {
        checks.push(['storybook installed', false, 'run this from the package that has Storybook installed (e.g. frontend/ in a monorepo)']);
    }
    const configDir = join(cwd, flag('-c') ?? flag('--config-dir') ?? '.storybook');
    const mainFile = ['main.ts', 'main.js', 'main.mjs', 'main.cjs', 'main.mts', 'main.cts'].map(f => join(configDir, f)).find(f => existsSync(f));
    const mainText = mainFile ? readFileSync(mainFile, 'utf8') : '';
    const builderRe = /^@storybook\/[\w-]+-(vite|webpack5)$|^@storybook\/builder-(vite|webpack5)$/;
    const framework = deps.find(d => builderRe.test(d)) ?? /@storybook\/[\w-]+-(vite|webpack5)/.exec(mainText)?.[0];
    checks.push(['vite or webpack 5 framework', Boolean(framework), framework ?? 'storyhub needs a Vite or webpack 5 based framework, e.g. @storybook/react-vite or @storybook/react-webpack5']);
    checks.push(['storyhub installed here', deps.includes('storyhub'), deps.includes('storyhub') ? 'yes' : 'add it as a devDependency of this package: npm install -D -E storyhub']);
    if (!mainFile) checks.push(['storybook config', false, `no main.* in ${configDir} (pass -c <dir> if it lives elsewhere)`]);
    else checks.push(['addon registered', /['"]storyhub['"]/.test(mainText), /['"]storyhub['"]/.test(mainText) ? mainFile : `add 'storyhub' to addons in ${mainFile}`]);
    for (const [name, ok, detail] of checks) console.log(`${ok ? '✓' : '✗'} ${name}: ${detail}`);
    if (checks.some(c => !c[1])) process.exitCode = 1;
}

try {
    if (cmd === '--version' || cmd === '-v' || cmd === 'version') console.log(version);
    else if (cmd === 'on') await toggle(true);
    else if (cmd === 'off') await toggle(false);
    else if (cmd === 'list') await list();
    else if (cmd === 'clean') await clean();
    else if (cmd === 'status') await status();
    else if (cmd === 'doctor') await doctor();
    else console.log(HELP);
} catch (err) {
    console.error(`storyhub: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
}
