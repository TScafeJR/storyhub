#!/usr/bin/env node
// Interactive release: commit pending work, test, bump, changelog, tag, push, publish.
//
//   npm run release              the real thing
//   npm run release -- --full    also run the browser E2E suite before releasing
//   npm run release -- --dry-run show every step without changing anything
//
// Not named "publish": that is an npm lifecycle script, which `pnpm publish` would run again.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const FULL = args.has('--full');

const bold = s => `\x1b[1m${s}\x1b[0m`;
const dim = s => `\x1b[2m${s}\x1b[0m`;
const step = s => console.log(`\n${bold('›')} ${bold(s)}`);
const fail = msg => {
    console.error(`\n✗ ${msg}`);
    process.exit(1);
};

/** Runs a command; `quiet` captures output, otherwise it is shown live (and can prompt). */
function run(cmd, cmdArgs, { quiet = false, allowFail = false, mutates = false } = {}) {
    const shown = `${cmd} ${cmdArgs.join(' ')}`;
    if (mutates && DRY) {
        console.log(dim(`  [dry-run] ${shown}`));
        return { ok: true, out: '' };
    }
    if (!quiet) console.log(dim(`  $ ${shown}`));
    const r = spawnSync(cmd, cmdArgs, { cwd: root, encoding: 'utf8', stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    const ok = r.status === 0;
    if (!ok && !allowFail) fail(`${shown} failed${quiet && r.stderr ? `:\n${r.stderr.trim()}` : ''}`);
    return { ok, out: (r.stdout ?? '').trim() };
}
const git = (...a) => run('git', a, { quiet: true }).out;

const rl = createInterface({ input: process.stdin, output: process.stdout });
let inputClosed = false;
rl.on('close', () => (inputClosed = true));
// a closed stdin (Ctrl-D, or input piped in and used up) answers "" which cancels
const ask = async q => (inputClosed ? '' : (await rl.question(q).catch(() => '')).trim().toLowerCase());
const confirm = async q => ['y', 'yes'].includes(await ask(`${q} [y/N] `));

/**
 * Arrow-key picker: ↑/↓ (or j/k) to move, Enter to choose, Esc / q / Ctrl-C to cancel, or press
 * the first letter of an option. Without a terminal (piped input) it falls back to typing a name.
 */
async function select(question, items, initial = 0) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        const names = items.map(i => i.value);
        items.forEach(i => console.log(`  ${i.label.padEnd(8)} ${i.detail}`));
        let answer = '';
        while (!names.includes(answer)) {
            answer = await ask(`${question} (${names.join('/')}): `);
            if (!answer) return null;
        }
        return answer;
    }
    rl.pause();
    const { emitKeypressEvents } = await import('node:readline');
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let index = Math.max(0, initial);
    const out = process.stdout;
    const render = first => {
        if (!first) out.write(`\x1b[${items.length}A`);
        for (const [i, item] of items.entries()) {
            const active = i === index;
            out.write(`\x1b[2K  ${active ? '\x1b[36m❯' : ' '} ${active ? bold(item.label.padEnd(8)) : item.label.padEnd(8)} ${active ? item.detail : dim(item.detail)}\x1b[0m\n`);
        }
    };
    out.write(`  ${bold(question)} ${dim('(↑/↓, Enter)')}\n\x1b[?25l`);
    render(true);
    return new Promise(resolve => {
        const done = value => {
            process.stdin.off('keypress', onKey);
            process.stdin.setRawMode(false);
            out.write('\x1b[?25h');
            rl.resume();
            resolve(value);
        };
        const onKey = (str, key = {}) => {
            if ((key.ctrl && key.name === 'c') || key.name === 'escape' || str === 'q') return done(null);
            if (key.name === 'return' || key.name === 'enter') return done(items[index].value);
            if (key.name === 'up' || str === 'k') index = (index - 1 + items.length) % items.length;
            else if (key.name === 'down' || str === 'j') index = (index + 1) % items.length;
            else {
                const hit = items.findIndex(i => str && i.label.startsWith(str.toLowerCase()));
                if (hit === -1) return;
                index = hit;
            }
            render(false);
        };
        process.stdin.on('keypress', onKey);
    });
}

const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
console.log(`${bold(pkg.name)} ${pkg.version}${DRY ? dim('  (dry run: nothing will change)') : ''}`);

// 1. Preflight: right branch, up to date, logged in. Nothing changes before these pass.
step('Preflight');
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') fail(`Releases go out from main; you are on ${branch}.`);
run('git', ['fetch', '--quiet', 'origin', 'main'], { quiet: true, allowFail: true });
const behind = Number(run('git', ['rev-list', '--count', 'HEAD..origin/main'], { quiet: true, allowFail: true }).out || 0);
if (behind > 0) fail(`main is ${behind} commit(s) behind origin/main. Pull first.`);
const who = run('npm', ['whoami'], { quiet: true, allowFail: true });
if (!who.ok) {
    if (DRY) console.log(dim('  not logged in to npm (a real release would stop here: run npm login)'));
    else fail('Not logged in to npm. Run `npm login` and try again.');
} else console.log(`  npm user: ${who.out}`);

// 2. Commit pending work, hunk by hunk.
step('Pending changes');
if (git('status', '--porcelain')) {
    if (DRY) console.log(dim('  [dry-run] git commit -p'));
    else {
        run('git', ['commit', '-p'], { allowFail: true });
        if (git('status', '--porcelain')) {
            console.log(git('status', '--short'));
            fail('Uncommitted changes remain. Commit or stash them (pnpm publish needs a clean tree), then run release again.');
        }
    }
} else console.log('  working tree clean');

// 3. Checks before the version moves, so a failure never leaves a tag behind.
step(FULL ? 'Checks (lint, typecheck, unit, browser E2E)' : 'Checks (lint, typecheck, unit; add --full for browser E2E)');
run('pnpm', ['lint']);
run('pnpm', ['typecheck']);
run('pnpm', ['test']);
if (FULL) run('pnpm', ['test:e2e']);

// 4. Pick the version.
step('Version');
const published = run('npm', ['view', `${pkg.name}@${pkg.version}`, 'version'], { quiet: true, allowFail: true }).out === pkg.version;
const currentTagged = run('git', ['rev-parse', '--verify', '--quiet', `v${pkg.version}^{commit}`], { quiet: true, allowFail: true }).ok;
const [maj, min, pat] = pkg.version.split('-')[0].split('.').map(Number);
const choices = { patch: `${maj}.${min}.${pat + 1}`, minor: `${maj}.${min + 1}.0`, major: `${maj + 1}.0.0` };
const items = [
    // "publish as is" only makes sense for a version that is neither on npm nor already tagged
    ...(!published && !currentTagged ? [{ value: 'current', label: 'current', detail: `${pkg.version}  (not on npm yet)` }] : []),
    { value: 'patch', label: 'patch', detail: `${choices.patch}  fixes` },
    { value: 'minor', label: 'minor', detail: `${choices.minor}  new features` },
    { value: 'major', label: 'major', detail: `${choices.major}  breaking changes` }
];
const type = await select(`Release type for ${pkg.name} ${pkg.version}`, items, items.findIndex(i => i.value === 'patch'));
if (!type) fail('Cancelled. Nothing was changed.');
const next = type === 'current' ? pkg.version : choices[type];
const tag = `v${next}`;
const tagCommit = run('git', ['rev-parse', '--verify', '--quiet', `${tag}^{commit}`], { quiet: true, allowFail: true }).out;
if (tagCommit) {
    if (type === 'current') {
        fail(`${tag} is already tagged (${tagCommit.slice(0, 7)}) but ${pkg.name}@${next} is not on npm, so an earlier publish did not finish. Release a patch instead (simplest), or publish that exact tag: git worktree add ../release-${next} ${tag}, install there, then pnpm publish --no-git-checks.`);
    }
    fail(`Tag ${tag} already exists.`);
}

// 5. Changelog draft from commits since the last release tag.
const changelogPath = join(root, 'CHANGELOG.md');
let changelog = readFileSync(changelogPath, 'utf8');
if (type !== 'current') {
    const lastTag = run('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*'], { quiet: true, allowFail: true }).out;
    const subjects = git('log', '--no-merges', '--format=%s', ...(lastTag ? [`${lastTag}..HEAD`] : []))
        .split('\n')
        .filter(s => s && !/^Release v\d/.test(s));
    const entry = `## ${next} (${new Date().toISOString().slice(0, 10)})\n\n${subjects.map(s => `- ${s}`).join('\n') || '- Maintenance release.'}\n\n`;
    changelog = changelog.replace(/^# Changelog\s*/, `# Changelog\n\n${entry}`);
    step(`Changelog entry for ${next}`);
    console.log(entry.trimEnd().replace(/^/gm, '  '));
}

// 6. Confirm, then do it.
step('Plan');
const plan = [
    ...(type === 'current' ? [] : [`set version ${pkg.version} → ${next}, update CHANGELOG.md, commit "Release ${tag}"`]),
    `tag ${tag}`,
    `push main and ${tag} (plus any unpushed release tags) to origin`,
    `pnpm publish ${pkg.name}@${next} to npm`
];
plan.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
if (!(await confirm('Go?'))) fail('Cancelled. Nothing was changed.');

// the tree must still be clean: anything that changed during checks would otherwise make
// pnpm publish refuse after the tag is already pushed
if (!DRY && git('status', '--porcelain')) {
    console.log(git('status', '--short'));
    fail('The working tree changed while the release was running. Nothing was committed, tagged or pushed.');
}

if (type !== 'current') {
    if (!DRY && (await confirm('Edit the changelog entry in your editor first?'))) {
        writeFileSync(changelogPath, changelog);
        rl.pause();
        run(process.env.VISUAL || process.env.EDITOR || 'vi', [changelogPath]);
        rl.resume();
    } else if (!DRY) writeFileSync(changelogPath, changelog);
    // re-read rather than reuse the startup copy, so nothing written meanwhile is lost
    if (!DRY) writeFileSync(pkgPath, `${JSON.stringify({ ...JSON.parse(readFileSync(pkgPath, 'utf8')), version: next }, null, 2)}\n`);
    else console.log(dim(`  [dry-run] write package.json version ${next} and CHANGELOG.md`));
    run('git', ['add', 'package.json', 'CHANGELOG.md'], { mutates: true });
    run('git', ['commit', '--quiet', '-m', `Release ${tag}`], { mutates: true });
}
run('git', ['tag', '-a', tag, '-m', tag], { mutates: true });

step('Push');
// --follow-tags also sends any earlier release tag that never made it to origin
run('git', ['push', '--atomic', '--follow-tags', 'origin', 'main'], { mutates: true });

step('Publish');
const pub = run('pnpm', ['publish'], { mutates: true, allowFail: true });
rl.close();
if (!pub.ok) fail(`pnpm publish failed. ${tag} is already pushed; fix the problem and run \`pnpm publish\` again (no new tag needed).`);
console.log(`\n✓ ${DRY ? 'Dry run complete.' : `Released ${pkg.name}@${next}: https://www.npmjs.com/package/${pkg.name}`}`);
