import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findCleanupCandidates } from '../../src/core/clean.js';
import { isSelected, matches, readSelection } from '../../src/core/selection.js';
import { gitCommonDir, listServers, registerServer } from '../../src/core/servers.js';
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
interface ListJson {
    include: string[];
    exclude: string[];
    servers: Array<{ url: string; root: string }>;
    worktrees: Array<{ branch: string; on: boolean; main: boolean; storybook: string | boolean }>;
}
const listJson = (cwd: string) => JSON.parse(cli(cwd, 'list', '--json').out) as ListJson;
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

    it('detects the checkout Storybook actually runs from, even a worktree', async () => {
        // a Storybook "running" from feat-new: the record this test process leaves is what a real
        // Storybook leaves, and this process is alive, so the CLI treats it as running
        const unregister = registerServer(await gitCommonDir(fx.hub), { root: fx.worktrees['feat-new'], configDir: '.storybook', url: 'http://localhost:6199', version: 'test' });
        try {
            const l = listJson(fx.hub);
            const row = (b: string) => l.worktrees.find(w => w.branch === b);
            expect(l.servers.map(x => x.url)).toEqual(['http://localhost:6199']);
            expect(row('feat-new')?.storybook).toBe('http://localhost:6199');
            expect(row('main')).toMatchObject({ storybook: false, main: true });
            expect(cli(fx.hub, 'list').out).toContain('Storybook is running from');

            // the checkout running Storybook cannot be a branch of itself
            const refused = cli(fx.worktrees['feat-new'], 'on');
            expect(refused.code).toBe(1);
            expect(refused.err).toContain('Storybook is running from this checkout (http://localhost:6199)');
            // ...but the main checkout can now be shown as a branch
            expect(cli(fx.hub, 'on').out).toContain('on   main');
            expect(isOn(fx.hub, 'main')).toBe(true);
            cli(fx.hub, 'off');
            expect(isOn(fx.hub, 'main')).toBe(false);
        } finally {
            unregister();
        }
        // once it stops, nothing is marked as the hub
        expect(listJson(fx.hub).worktrees.some(w => w.storybook)).toBe(false);
    });

    it('ignores records left by Storybooks that are no longer running', async () => {
        const dir = join(await gitCommonDir(fx.hub), 'storyhub', 'servers');
        mkdirSync(dir, { recursive: true });
        const stale = join(dir, '999999.json');
        writeFileSync(stale, JSON.stringify({ pid: 999999, root: fx.hub, configDir: '.storybook', url: 'http://localhost:1', version: 'x', startedAt: new Date().toISOString() }));
        expect(listServers(await gitCommonDir(fx.hub))).toEqual([]);
        expect(existsSync(stale)).toBe(false); // cleaned up
    });

    it('StoryHub only computes worktrees that are on', async () => {
        let server: ViteDevServer | undefined;
        let hub: StoryHub | undefined;
        try {
            server = await resolverServer(fx.hub);
            cli(fx.worktrees['feat-new'], 'off');
            hub = await StoryHub.create({ cwd: fx.hub, isStoryFile: rel => rel.endsWith('.stories.tsx'), resolve: viteResolver(server) });
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
        expect(by('feat-label').reasons).toEqual(['no commits of its own (sits on main)']);
        expect(by('feat-label').removable).toBe(false);
        expect(by('feat-label').blockers[0]).toContain('uncommitted changes');
        expect(by('feat-ui').reasons).toEqual([]);

        // a worktree Storybook is running from is never removed, even when merged
        const unregister = registerServer(await gitCommonDir(c.hub), { root: c.worktrees['feat-button'], configDir: '.storybook', url: 'http://localhost:6198', version: 'test' });
        const whileRunning = (await findCleanupCandidates(c.hub)).candidates.find(x => x.branch === 'feat-button')!;
        expect(whileRunning.removable).toBe(false);
        expect(whileRunning.blockers).toContain('Storybook is running from it (http://localhost:6198)');
        unregister();

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
