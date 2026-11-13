import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import tailwindVite from '@tailwindcss/vite';
import postcss from 'postcss';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StoryHub } from '../../src/core/state.js';
import { isTailwind4Entry, mirrorContentGlobs, ROOT_ENV, withWorktreeSources, worktreeSources } from '../../src/core/tailwind.js';
import { withStoryhub } from '../../src/tailwind.js';
import { storyhubVitePlugin } from '../../src/vite/plugin.js';
// @ts-expect-error untyped fixture script
import { runGit } from '../fixtures/create-fixture.mjs';

const require = createRequire(import.meta.url);

describe('Tailwind helpers', () => {
    const opts = { gitRoot: '/repo', base: '/repo/app', worktrees: ['/wt/a', '/wt/b'] };

    it('mirrors Tailwind 3 content globs into every worktree, keeping negations', () => {
        expect(mirrorContentGlobs(['./src/**/*.tsx', '!./src/legacy/**', '/repo/shared/*.ts', '/elsewhere/*.ts'], opts)).toEqual([
            '/wt/a/app/src/**/*.tsx',
            '/wt/b/app/src/**/*.tsx',
            '!/wt/a/app/src/legacy/**',
            '!/wt/b/app/src/legacy/**',
            '/wt/a/shared/*.ts',
            '/wt/b/shared/*.ts'
        ]);
    });

    it('adds each worktree as a Tailwind 4 source: the detection root plus explicit @source paths', () => {
        const css = `@import "tailwindcss";\n@source "../ui/**/*.tsx";\n@source not "../ui/legacy";`;
        expect(worktreeSources(css, '/repo/app/src/index.css', opts).trim().split('\n')).toEqual([
            '@source "/wt/a/app";',
            '@source "/wt/b/app";',
            '@source "/wt/a/app/ui/**/*.tsx";',
            '@source "/wt/b/app/ui/**/*.tsx";'
        ]);
    });

    it('follows source("dir") and source(none) on the Tailwind import', () => {
        expect(worktreeSources(`@import "tailwindcss" source("../lib");`, '/repo/app/src/index.css', opts)).toContain('@source "/wt/a/app/lib";');
        expect(worktreeSources(`@import 'tailwindcss' source(none);`, '/repo/app/src/index.css', opts)).toBe('');
        expect(worktreeSources(`@import "tailwindcss";`, '/repo/app/src/index.css', { ...opts, worktrees: [] })).toBe('');
    });

    it('imports the sources from a generated file, rewritten only when they change', () => {
        const cacheDir = join(realpathSync(mkdtempSync(join(tmpdir(), 'storyhub-twc-'))), 'cache');
        const css = '@charset "utf-8";\n@import "tailwindcss";\n';
        const out = withWorktreeSources(css, '/repo/app/src/index.css', { ...opts, cacheDir });
        const [, generated] = /@import "([^"]+)";/.exec(out)!;
        expect(out.startsWith(`@charset "utf-8";\n@import "${generated}";\n@import "tailwindcss";`)).toBe(true);
        expect(readFileSync(generated, 'utf8')).toContain('@source "/wt/a/app";');
        const written = statSync(generated).mtimeMs;
        withWorktreeSources(css, '/repo/app/src/index.css', { ...opts, cacheDir });
        expect(statSync(generated).mtimeMs).toBe(written);
        // no branch on: still imported (a dependency from the first build), but with no sources
        expect(withWorktreeSources(css, '/repo/app/src/index.css', { ...opts, worktrees: [], cacheDir })).toContain(generated);
        expect(readFileSync(generated, 'utf8')).not.toContain('@source');
    });

    it('treats only Tailwind 4 stylesheets as entries', () => {
        const file = join(dirname(require.resolve('tailwindcss/package.json')), 'index.css'); // resolves tailwindcss 4
        expect(isTailwind4Entry('@import "tailwindcss";', file)).toBe(true);
        expect(isTailwind4Entry('body { color: red; }', file)).toBe(false);
        // where no tailwindcss resolves, fall back to syntax: v3's `@tailwind` directives stay untouched
        expect(isTailwind4Entry('@tailwind base;\n@tailwind utilities;', '/nowhere/index.css')).toBe(false);
        expect(isTailwind4Entry('@import "tailwindcss";', '/nowhere/index.css')).toBe(true);
    });
});

function write(root: string, files: Record<string, string>) {
    for (const [rel, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), content);
    }
}

/** A hub checkout plus a `feat` worktree whose new component uses classes the hub never does. */
function makeRepo({ on = true } = {}) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'storyhub-tw-')));
    const hub = join(dir, 'hub');
    write(hub, {
        '.gitignore': 'node_modules\n',
        '.storybook/main.ts': 'export default { stories: [] };\n',
        'src/index.css': '@import "tailwindcss";\n',
        'src/App.tsx': 'export const App = () => <div className="p-4">app</div>;\n'
    });
    runGit(hub, 'init', '-q', '-b', 'main');
    runGit(hub, 'add', '-A');
    runGit(hub, 'commit', '-q', '-m', 'init');
    const feat = join(dir, 'feat');
    runGit(hub, 'worktree', 'add', '-q', '-b', 'feat', feat);
    write(feat, { 'src/Panel.tsx': 'export const Panel = () => <img className="h-44 xl:max-w-[720px]" />;\n' });
    if (on) runGit(hub, 'config', '--add', 'storyhub.include', 'feat');
    // Tailwind 4 resolves `@import "tailwindcss"` from the stylesheet, so the hub needs the package
    mkdirSync(join(hub, 'node_modules'), { recursive: true });
    symlinkSync(dirname(require.resolve('tailwindcss/package.json')), join(hub, 'node_modules/tailwindcss'));
    return { hub, feat };
}

describe('Tailwind 4 in a storyhub Vite server', () => {
    let repo: ReturnType<typeof makeRepo>;
    let server: ViteDevServer;
    let hub: StoryHub;

    beforeAll(async () => {
        repo = makeRepo({ on: false });
        let ready!: (h: StoryHub) => void;
        const hubReady = new Promise<StoryHub>(r => (ready = r));
        server = await createServer({
            root: repo.hub,
            configFile: false,
            logLevel: 'silent',
            appType: 'custom',
            // Tailwind's plugin comes first, as it would in a project's own config; storyhub's
            // `order: 'pre'` transform must still run before it
            plugins: [
                tailwindVite(),
                storyhubVitePlugin({ gitRoot: repo.hub, configDir: join(repo.hub, '.storybook'), isStoryFile: rel => rel.endsWith('.stories.tsx'), onHub: h => ready(h) })
            ],
            server: { middlewareMode: true, hmr: false },
            optimizeDeps: { noDiscovery: true, include: [] }
        });
        hub = await hubReady;
    });

    afterAll(async () => {
        await server?.close();
    });

    const css = async () => (await server.transformRequest('/src/index.css'))?.code ?? '';

    it('leaves branch-only classes out while the branch is off', async () => {
        const out = await css();
        expect(out).toContain('.p-4');
        expect(out).not.toContain('.h-44');
    });

    // the order that matters live: Tailwind 4's dev server only ever adds classes, so turning a
    // branch off leaves its classes in place (harmless), but turning one on must regenerate
    it('regenerates the stylesheet with branch-only classes when the branch is turned on', async () => {
        runGit(repo.hub, 'config', '--add', 'storyhub.include', 'feat');
        await hub.refresh();
        const end = Date.now() + 10_000;
        let out = await css();
        while (!out.includes('.h-44') && Date.now() < end) {
            await new Promise(r => setTimeout(r, 100));
            out = await css();
        }
        expect(out).toContain('.p-4');
        expect(out).toContain('.h-44');
        expect(out).toMatch(/max-width:\s*720px/);
    });
});

describe('Tailwind 3 with withStoryhub', () => {
    let repo: ReturnType<typeof makeRepo>;
    const tailwind3 = require('tailwindcss3') as (config: object) => postcss.AcceptedPlugin;
    const build = async (config: object) => (await postcss([tailwind3(config)]).process('@tailwind utilities;', { from: join(repo.hub, 'src/index.css') })).css;

    beforeAll(() => {
        repo = makeRepo();
    });

    afterAll(() => {
        delete process.env[ROOT_ENV];
    });

    it('does nothing outside a storyhub Storybook', async () => {
        delete process.env[ROOT_ENV];
        const config = { content: ['./src/**/*.tsx'] };
        expect(withStoryhub(config, { base: repo.hub })).toBe(config);
    });

    it('scans the worktrees inside one, so branch-only classes are generated', async () => {
        process.env[ROOT_ENV] = repo.hub;
        const config = withStoryhub({ content: ['./src/**/*.tsx'] }, { base: repo.hub });
        expect(config.content).toEqual(['./src/**/*.tsx', `${repo.feat}/src/**/*.tsx`]);
        const out = await build({ ...config, content: config.content.map(g => (g.startsWith('./') ? join(repo.hub, g) : g)) });
        expect(out).toContain('.p-4');
        expect(out).toContain('.h-44');
        expect(out).toMatch(/max-width:\s*720px/);
        // the object form (`content: { files }`) is extended the same way
        expect(withStoryhub({ content: { files: ['./src/**/*.tsx'], relative: true } }, { base: repo.hub }).content.files).toContain(`${repo.feat}/src/**/*.tsx`);
    });
});
