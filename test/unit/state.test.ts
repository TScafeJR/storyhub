import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StoryHub } from '../../src/core/state.js';
import { viteResolver } from '../../src/vite/resolver.js';
import { makeFixture, resolverServer, type Fixture } from '../helpers.js';

let fx: Fixture;
let server: ViteDevServer;
let hub: StoryHub;

beforeAll(async () => {
    fx = makeFixture({ library: false });
    server = await resolverServer(fx.hub);
    hub = await StoryHub.create({
        cwd: fx.hub,
        configDir: join(fx.hub, '.storybook'),
        isStoryFile: rel => /\.stories\.tsx$/.test(rel),
        previewFiles: ['.storybook/preview.tsx'],
        resolve: viteResolver(server)
    });
});

afterAll(async () => {
    await hub?.close();
    await server?.close();
});

const branch = (id: string) => {
    const b = hub.branches.get(id);
    if (!b) throw new Error(`no branch ${id}; have ${[...hub.branches.keys()]}`);
    return b;
};

describe('StoryHub on the fixture repo', () => {
    it('discovers every non-hub worktree as a branch', () => {
        expect([...hub.branches.keys()]).toEqual(['feat-button', 'feat-label', 'feat-new', 'feat-theme', 'feat-ui']);
        expect(hub.hubStories.sort()).toEqual([
            'src/components/Badge.stories.tsx',
            'src/components/Button.stories.tsx',
            'src/components/Card.stories.tsx',
            'src/components/Late.stories.tsx',
            'src/components/Panel.stories.tsx'
        ]);
    });

    it('a leaf component change affects every story that imports it', () => {
        const b = branch('feat-button');
        expect(b.changes).toEqual([{ rel: 'src/components/Button.tsx', kind: 'M' }]);
        expect(b.affectedStories).toEqual(['src/components/Button.stories.tsx', 'src/components/Card.stories.tsx']);
        expect(b.drift).toEqual([]);
        expect(b.dirty.has('src/theme.ts')).toBe(false);
        // added on main after the branch split: dirty (it imports Button) but not in the worktree
        expect(b.dirty.has('src/components/Late.stories.tsx')).toBe(true);
        expect(hub.reason('feat-button', 'src/components/Card.stories.tsx')).toEqual([
            'src/components/Card.stories.tsx',
            'src/components/Card.tsx',
            'src/components/Button.tsx'
        ]);
    });

    it('uncommitted changes reached through a path alias are detected', () => {
        const b = branch('feat-label');
        expect(b.changes).toEqual([{ rel: 'src/components/Label.tsx', kind: 'M' }]);
        expect(b.affectedStories).toEqual(['src/components/Card.stories.tsx']);
    });

    it('new story files are affected and deleted ones are dropped', () => {
        const b = branch('feat-new');
        expect(b.changes).toEqual([
            { rel: 'src/components/Badge.stories.tsx', kind: 'D' },
            { rel: 'src/components/Chip.stories.tsx', kind: 'A' },
            { rel: 'src/components/Chip.tsx', kind: 'A' }
        ]);
        expect(b.affectedStories).toEqual(['src/components/Chip.stories.tsx']);
        expect(b.dirty.has('src/components/Chip.tsx')).toBe(true);
    });

    it('workspace package edits propagate and dependency drift is flagged', () => {
        const b = branch('feat-ui');
        expect(b.affectedStories).toEqual(['src/components/Panel.stories.tsx']);
        expect(b.drift).toContain('deps-drift');
        expect(b.dirty.has('packages/ui/src/index.ts')).toBe(true);
    });

    it('a branch that dirties a preview import renders with its own preview copy', () => {
        const b = branch('feat-theme');
        expect(b.affectedStories).toEqual(['src/components/Button.stories.tsx', 'src/components/Card.stories.tsx']);
        expect(b.previewOverrides).toEqual(['.storybook/preview.tsx']);
        expect(b.drift).toEqual([]);
        expect(branch('feat-button').previewOverrides).toEqual([]);
    });

    it('summaries expose ref URLs and counts', () => {
        const s = hub.summaries().find(x => x.id === 'feat-button')!;
        expect(s).toMatchObject({ branch: 'feat-button', changedFiles: 1, affectedStories: 2, refUrl: '/__storyhub/feat-button' });
    });

    it('refresh picks up new edits in a worktree', async () => {
        const changed = new Promise(resolve => hub.once('change', resolve));
        writeFileSync(join(fx.worktrees['feat-button'], 'src/components/Badge.tsx'), `import React from 'react';\nexport const Badge = () => <em>badge v2</em>;\n`);
        await hub.refresh();
        await changed;
        expect(branch('feat-button').affectedStories).toContain('src/components/Badge.stories.tsx');
    });

    it('branchForPath maps worktree files to their branch', () => {
        expect(hub.branchForPath(join(fx.worktrees['feat-new'], 'src/components/Chip.tsx'))?.worktree.id).toBe('feat-new');
        expect(hub.branchForPath(join(fx.hub, 'src/components/Chip.tsx'))).toBeUndefined();
    });
});
