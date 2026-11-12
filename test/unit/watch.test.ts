import type { ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StoryHub } from '../../src/core/state.js';
import { viteResolver } from '../../src/vite/resolver.js';
// @ts-expect-error untyped fixture script
import { runGit } from '../fixtures/create-fixture.mjs';
import { makeFixture, resolverServer, type Fixture } from '../helpers.js';

let fx: Fixture;
let server: ViteDevServer;
const hubs: StoryHub[] = [];

beforeAll(async () => {
    fx = makeFixture({ install: false });
    server = await resolverServer(fx.hub);
});

afterAll(async () => {
    await Promise.all(hubs.map(h => h.close()));
    await server?.close();
});

const nextChange = (hub: StoryHub, ms = 10_000) =>
    new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no change event: git metadata is not being watched')), ms);
        hub.once('change', () => {
            clearTimeout(timer);
            resolve();
        });
    });

describe('live selection changes', () => {
    // From a linked worktree, `git rev-parse --git-common-dir` is absolute; it used to be joined onto
    // the checkout root, giving a path that does not exist, so git config was never watched there.
    for (const where of ['main checkout', 'linked worktree'] as const) {
        it(`are picked up without a restart when Storybook runs from the ${where}`, async () => {
            const cwd = where === 'main checkout' ? fx.hub : fx.worktrees['feat-new'];
            const hub = await StoryHub.create({ cwd, isStoryFile: rel => rel.endsWith('.stories.tsx'), resolve: viteResolver(server), watch: { hub: false }, debounceMs: 50 });
            hubs.push(hub);
            const target = where === 'main checkout' ? 'feat-ui' : 'main';
            const id = target; // branch ids equal these branch names
            try {
                runGit(fx.hub, 'config', '--unset-all', 'storyhub.include', `^${target}$`);
            } catch {
                // not on yet
            }
            await hub.refresh();
            expect(hub.branches.has(id)).toBe(false);

            const changed = nextChange(hub);
            runGit(fx.hub, 'config', '--add', 'storyhub.include', target);
            await changed;
            expect(hub.branches.has(id)).toBe(true);
        });
    }
});
