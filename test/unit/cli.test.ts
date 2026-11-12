import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findCleanupCandidates } from '../../src/core/clean.js';
import { isSelected, matches, readSelection } from '../../src/core/selection.js';
import { StoryHub } from '../../src/core/state.js';
import { viteResolver } from '../../src/vite/resolver.js';
// @ts-expect-error untyped fixture script
import { runGit } from '../fixtures/create-fixture.mjs';
import { makeFixture, resolverServer, type Fixture } from '../helpers.js';

const CLI = resolve(__dirname, '../../dist/cli.js');
const cli = (cwd: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
    return { code: r.status, out: r.stdout, err: r.stderr };
};
const listJson = (cwd: string) => JSON.parse(cli(cwd, 'list', '--json').out) as { include: string[]; exclude: string[]; worktrees: Array<{ branch: string; on: boolean; main: boolean }> };
const isOn = (cwd: string, branch: string) => listJson(cwd).worktrees.find(w => w.branch === branch)?.on;

let fx: Fixture;

beforeAll(() => {
    if (!existsSync(CLI)) execFileSync('pnpm', ['build'], { cwd: resolve(__dirname, '../..'), stdio: 'ignore' });
    fx = makeFixture({ install: false });
});

describe('selection patterns', () => {
    const wt = { id: 'feat-login', path: '/w/app-login', head: 'x', branch: 'feat/login', isHub: false };
    it('match branch, id, directory name, path and globs', () => {
        for (const p of ['feat/login', 'feat-login', 'app-login', '/w/app-login', 'feat/*', '*login']) expect(matches(wt, p)).toBe(true);
        expect(matches(wt, 'feat/logout')).toBe(false);
        expect(matches(wt, 'feat')).toBe(false);
    });
    it('are opt-in by default, exclude wins, and the hub is never a branch', () => {
        expect(isSelected(wt, { mode: 'opt-in', include: [], exclude: [] })).toBe(false);
        expect(isSelected(wt, { mode: 'opt-in', include: ['feat/*'], exclude: [] })).toBe(true);
        expect(isSelected(wt, { mode: 'opt-in', include: ['feat/*'], exclude: ['feat/login'] })).toBe(false);
        expect(isSelected(wt, { mode: 'all', include: [], exclude: [] })).toBe(true);
        expect(isSelected({ ...wt, isHub: true }, { mode: 'all', include: [], exclude: [] })).toBe(false);
    });
});

describe('storyhub on / off / list', () => {
    it('lists every worktree with its state', () => {
        const l = listJson(fx.hub);
        expect(l.worktrees.find(w => w.main)?.branch).toBe('main');
        expect(l.worktrees.filter(w => w.on).map(w => w.branch).sort()).toEqual(['feat-button', 'feat-label', 'feat-new', 'feat-theme', 'feat-ui']);
    });

    it('toggles the worktree it is run in when no target is given', () => {
        const wt = fx.worktrees['feat-button'];
        expect(cli(wt, 'off').out).toContain('off  feat-button');
        expect(isOn(fx.hub, 'feat-button')).toBe(false);
        expect(cli(join(wt, 'src/components'), 'on').out).toContain('on   feat-button'); // works from a subdirectory too
        expect(isOn(fx.hub, 'feat-button')).toBe(true);
    });

    it('saves globs as patterns that also cover future worktrees', () => {
        runGit(fx.hub, 'worktree', 'add', '-q', '-b', 'exp/one', join(fx.dir, 'exp-one'));
        expect(isOn(fx.hub, 'exp/one')).toBe(false);
        expect(cli(fx.hub, 'on', 'exp/*').out).toContain('matches exp/one');
        runGit(fx.hub, 'worktree', 'add', '-q', '-b', 'exp/two', join(fx.dir, 'exp-two'));
        expect(isOn(fx.hub, 'exp/two')).toBe(true);
        // switching one off under a glob records an exclude for just that one
        cli(fx.worktrees['feat-button'], 'off', 'exp/two');
        expect(isOn(fx.hub, 'exp/two')).toBe(false);
        expect(isOn(fx.hub, 'exp/one')).toBe(true);
        cli(fx.hub, 'off', 'exp/*');
        expect(isOn(fx.hub, 'exp/one')).toBe(false);
    });

    it('refuses to toggle the main checkout itself', () => {
        const r = cli(fx.hub, 'on');
        expect(r.code).toBe(1);
        expect(r.err).toContain('main checkout');
    });

    it('StoryHub only computes worktrees that are on', async () => {
        let server: ViteDevServer | undefined;
        let hub: StoryHub | undefined;
        try {
            server = await resolverServer(fx.hub);
            cli(fx.worktrees['feat-new'], 'off');
            hub = await StoryHub.create({ cwd: fx.hub, isStoryFile: rel => /\.stories\.tsx$/.test(rel), resolve: viteResolver(server) });
            expect(hub.branches.has('feat-new')).toBe(false);
            expect(hub.allWorktrees.find(w => w.id === 'feat-new')?.selected).toBe(false);
            expect(hub.branches.has('feat-button')).toBe(true);
            cli(fx.worktrees['feat-new'], 'on');
            await hub.refresh();
            expect(hub.branches.has('feat-new')).toBe(true);
        } finally {
            await hub?.close();
            await server?.close();
        }
    });
});

describe('storyhub clean', () => {
    afterAll(() => undefined);

    it('finds merged and squash-merged worktrees, keeps ones with local work, and removes only with --yes', async () => {
        const c = makeFixture({ install: false });
        runGit(c.hub, 'merge', '-q', '--no-ff', '-m', 'merge feat-button', 'feat-button');
        // squash-merge feat-new: same end state on main, no ancestry
        runGit(c.hub, 'checkout', 'feat-new', '--', 'src/components/Chip.tsx', 'src/components/Chip.stories.tsx');
        runGit(c.hub, 'rm', '-q', 'src/components/Badge.stories.tsx');
        runGit(c.hub, 'commit', '-q', '-m', 'squash feat-new');

        const report = await findCleanupCandidates(c.hub);
        const by = (b: string) => report.candidates.find(x => x.branch === b)!;
        expect(report.base).toBe('main');
        expect(by('feat-button')).toMatchObject({ removable: true, reasons: ['merged into main'] });
        expect(by('feat-new').reasons).toEqual(['changes already in main (squash/rebase merged)']);
        expect(by('feat-new').removable).toBe(true);
        // feat-label has no commits (so it is "merged") but uncommitted work: never removed
        expect(by('feat-label').removable).toBe(false);
        expect(by('feat-label').blockers[0]).toContain('uncommitted changes');
        expect(by('feat-ui').reasons).toEqual([]);

        const dry = cli(c.hub, 'clean');
        expect(dry.out).toContain('Dry run');
        expect(existsSync(c.worktrees['feat-button'])).toBe(true);

        const run = cli(c.hub, 'clean', '--yes', '--delete-branches');
        expect(run.code).toBe(0);
        expect(existsSync(c.worktrees['feat-button'])).toBe(false);
        expect(existsSync(c.worktrees['feat-new'])).toBe(false);
        expect(existsSync(c.worktrees['feat-label'])).toBe(true);
        expect(existsSync(c.worktrees['feat-ui'])).toBe(true);
        expect(run.out).toContain('deleted branches: feat-button');
        expect(run.out).toContain('git -d refused'); // squash-merged branches are not deleted with -d
        const branches = runGit(c.hub, 'branch', '--format=%(refname:short)') as string;
        expect(branches).not.toMatch(/^feat-button$/m);
        expect(branches).toMatch(/^feat-new$/m);
        // the removed worktrees' opt-in entries are cleaned out of git config
        const sel = await readSelection(c.hub);
        expect(sel.include).not.toContain('feat-button');
        expect(sel.include).toContain('feat-ui');
    });
});
