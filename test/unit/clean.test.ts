import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { findCleanupCandidates, removeWorktrees } from '../../src/core/clean.js';
import { gitCommonDir } from '../../src/core/servers.js';
import { doom, ignoredNodeModules, putBack, recover, setAside, sweep, trashDir } from '../../src/core/trash.js';
// @ts-expect-error untyped fixture script
import { runGit } from '../fixtures/create-fixture.mjs';
import { makeFixture, type Fixture } from '../helpers.js';

const write = (file: string, content = 'x') => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
};
const trashed = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);
const until = async (done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i++) await new Promise(r => setTimeout(r, 50));
    expect(done()).toBe(true);
};
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

let fx: Fixture;
let wt: string;
let trash: string;

beforeEach(async () => {
    fx = makeFixture({ install: false, scenarios: ['feat-button'] });
    runGit(fx.hub, 'merge', '-q', '--no-ff', '-m', 'merge feat-button', 'feat-button');
    wt = fx.worktrees['feat-button'];
    trash = trashDir(await gitCommonDir(fx.hub));
    write(join(wt, 'node_modules/dep/index.js'), 'root');
    write(join(wt, 'packages/nested/node_modules/dep/index.js'), 'nested');
});

const candidates = async () => {
    const found = (await findCleanupCandidates(fx.hub)).candidates;
    expect(found.map(c => [c.branch, c.removable])).toEqual([['feat-button', true]]);
    return found;
};
const expectInPlace = () => {
    expect(readFileSync(join(wt, 'node_modules/dep/index.js'), 'utf8')).toBe('root');
    expect(readFileSync(join(wt, 'packages/nested/node_modules/dep/index.js'), 'utf8')).toBe('nested');
};

const run = (...args: string[]) => spawnSync(process.execPath, [resolve(__dirname, '../../dist/cli.js'), 'clean', ...args], { cwd: fx.hub, encoding: 'utf8' });

describe('clean with node_modules', () => {
    it('finds only real, ignored node_modules directories', async () => {
        write(join(wt, 'storybook-static/index.html')); // ignored, but not node_modules
        mkdirSync(join(wt, 'packages/linked'), { recursive: true });
        symlinkSync(join(wt, 'node_modules'), join(wt, 'packages/linked/node_modules'));
        expect((await ignoredNodeModules(wt)).sort()).toEqual(['node_modules', 'packages/nested/node_modules']);
        writeFileSync(join(wt, '.gitignore'), 'storybook-static\n');
        expect(await ignoredNodeModules(wt)).toEqual([]);
    });

    it('removes the worktree, then deletes its node_modules in the background', async () => {
        const result = await removeWorktrees(fx.hub, await candidates());
        expect(result).toMatchObject({ removed: [wt], kept: [], deletingInBackground: 1 });
        expect(existsSync(wt)).toBe(false);
        await until(() => trashed(trash).length === 0);
    });

    it('reports nothing in the background when there was no node_modules', async () => {
        runGit(wt, 'clean', '-fdxq');
        expect(await removeWorktrees(fx.hub, await candidates())).toMatchObject({ removed: [wt], deletingInBackground: 0 });
        expect(existsSync(trash)).toBe(false);
    });

    it('leaves the target of a symlinked node_modules alone', async () => {
        const shared = join(fx.dir, 'shared');
        write(join(shared, 'keep.js'));
        mkdirSync(join(wt, 'packages/linked'), { recursive: true });
        symlinkSync(shared, join(wt, 'packages/linked/node_modules'));
        expect((await removeWorktrees(fx.hub, await candidates())).removed).toEqual([wt]);
        await until(() => trashed(trash).length === 0);
        expect(existsSync(join(shared, 'keep.js'))).toBe(true);
    });

    it('moves nothing when the worktree was edited after it was checked', async () => {
        const found = await candidates();
        write(join(wt, 'new-work.ts'));
        const result = await removeWorktrees(fx.hub, found);
        expect(result.removed).toEqual([]);
        expect(result.kept[0].path).toBe(wt);
        expectInPlace();
        expect(existsSync(trash)).toBe(false); // never moved, not moved and put back
    });

    it('moves nothing when the worktree was locked after it was checked', async () => {
        const found = await candidates();
        runGit(fx.hub, 'worktree', 'lock', wt);
        expect((await removeWorktrees(fx.hub, found)).removed).toEqual([]);
        expectInPlace();
        expect(existsSync(trash)).toBe(false);
    });

    it('puts node_modules back when git refuses the removal', async () => {
        // git refuses worktrees with submodules, which neither status nor the lock check shows
        const inode = statSync(join(wt, 'node_modules')).ino;
        mkdirSync(join(await gitCommonDir(fx.hub), 'worktrees/feat-button/modules/sub'), { recursive: true });
        const result = await removeWorktrees(fx.hub, await candidates());
        expect(result.removed).toEqual([]);
        expect(result.kept).toEqual([{ path: wt, error: expect.stringContaining('submodules') }]);
        expect(result.deletingInBackground).toBe(0);
        expectInPlace();
        expect(statSync(join(wt, 'node_modules')).ino).toBe(inode);
        expect(existsSync(trash)).toBe(true); // it was moved
        expect(trashed(trash)).toEqual([]);
    });

    it('falls back to a plain removal when nothing can be moved', async () => {
        write(trash, 'a file where the directory should be');
        expect(await removeWorktrees(fx.hub, await candidates())).toMatchObject({ removed: [wt], kept: [], deletingInBackground: 0 });
        expect(existsSync(wt)).toBe(false);
    });

    it('deletes what an interrupted background delete left behind', async () => {
        write(join(trash, 'doomed-old/0/dep/index.js'));
        expect(await removeWorktrees(fx.hub, [])).toMatchObject({ removed: [], deletingInBackground: 1 });
        await until(() => trashed(trash).length === 0);
    });

    it('is told about in the CLI output, and a dry run touches nothing', () => {
        expect(run().status).toBe(0);
        expectInPlace();
        expect(existsSync(trash)).toBe(false);
        expect(run('--yes').stdout).toContain('deleting node_modules of 1 worktree(s) in the background');
    });
});

/** A batch as a killed clean would leave it. */
const abandoned = () => {
    const batch = setAside(trash, wt, ['node_modules', 'packages/nested/node_modules'])!;
    const manifest = join(batch.dir, 'manifest.json');
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), pid: deadPid() }));
    return batch;
};

describe('trash batches', () => {
    it('put back exactly what they took', () => {
        const batch = setAside(trash, wt, ['node_modules', 'packages/nested/node_modules'])!;
        expect(existsSync(join(wt, 'node_modules'))).toBe(false);
        expect(putBack(batch)).toBe(true);
        expectInPlace();
        expect(trashed(trash)).toEqual([]);
    });

    it('never overwrite, and keep what cannot be put back', () => {
        const batch = setAside(trash, wt, ['node_modules'])!;
        write(join(wt, 'node_modules/fresh.js'));
        expect(putBack(batch)).toBe(false);
        expect(existsSync(join(wt, 'node_modules/fresh.js'))).toBe(true);
        expect(existsSync(join(batch.dir, '0/dep/index.js'))).toBe(true);
        expect(sweep(trash)).toBe(0); // pending batches are never deleted
    });

    it('are not created when nothing could be moved', () => {
        expect(setAside(trash, wt, [])).toBeNull();
        expect(setAside(trash, wt, ['missing/node_modules'])).toBeNull();
        expect(trashed(trash)).toEqual([]);
    });

    it('are put back by the next run after a killed clean', async () => {
        abandoned();
        expect(await removeWorktrees(fx.hub, [])).toMatchObject({ kept: [], deletingInBackground: 0 });
        expectInPlace();
        expect(trashed(trash)).toEqual([]);
    });

    it('are deleted by the next run if the worktree did get removed', async () => {
        abandoned();
        runGit(fx.hub, 'worktree', 'remove', wt);
        expect(recover(trash)).toEqual([]);
        expect(trashed(trash)).toEqual([expect.stringMatching(/^doomed-/)]);
    });

    it('are reported when the next run cannot put them back', async () => {
        const batch = abandoned();
        write(join(wt, 'node_modules/fresh.js'));
        const { kept } = await removeWorktrees(fx.hub, []);
        expect(kept).toEqual([{ path: wt, error: expect.stringContaining(batch.dir) }]);
        expect(existsSync(join(batch.dir, '0/dep/index.js'))).toBe(true);
    });

    it('of a running clean, or with an unreadable manifest, are left alone', () => {
        const live = setAside(trash, wt, ['node_modules'])!;
        write(join(trash, 'pending-odd/manifest.json'), '{');
        expect(recover(trash)).toEqual([]);
        expect(existsSync(join(live.dir, '0'))).toBe(true);
        expect(lstatSync(join(trash, 'pending-odd')).isDirectory()).toBe(true);
    });

    it('are only deleted once doomed', async () => {
        const batch = setAside(trash, wt, ['node_modules'])!;
        doom(batch);
        expect(sweep(trash)).toBe(1);
        await until(() => trashed(trash).length === 0);
    });
});
