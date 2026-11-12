import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error untyped fixture script
import { runGit } from '../fixtures/create-fixture.mjs';
import { makeFixture, type Fixture } from '../helpers.js';

const freePort = () =>
    new Promise<number>((resolve, reject) => {
        const srv = createServer();
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address() as { port: number };
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });

const toolJson = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);
const sidebar = async (page: Page) => (await page.locator('#storybook-explorer-tree').innerText()).split('\n').map(s => s.trim()).filter(Boolean);

function suite(builder: 'vite' | 'webpack') {
    let fx: Fixture;
    let sb: ChildProcess;
    let base: string;
    let browser: Browser;
    let log = '';

    const until = async <T>(fn: () => Promise<T | undefined | false>, what: string, timeout = 30_000): Promise<T> => {
        const end = Date.now() + timeout;
        let last: unknown;
        while (Date.now() < end) {
            try {
                const v = await fn();
                if (v) return v;
            } catch (err) {
                last = err;
            }
            await new Promise(r => setTimeout(r, 250));
        }
        throw new Error(`timed out waiting for ${what}${last ? `: ${last}` : ''}\n--- storybook log ---\n${log.slice(-3000)}`);
    };

    const branches = async () => (await (await fetch(`${base}/__storyhub/branches.json`)).json()).branches as Array<{ id: string; affectedStories: number; drift: string[] }>;
    const branchIndex = async (id: string) => (await (await fetch(`${base}/__storyhub/${id}/index.json`)).json()).entries as Record<string, { importPath: string }>;



    const renderedRoot = async (page: Page, path: string, selector: string) => {
        await page.goto(base + path);
        await page.waitForSelector(selector, { timeout: 20_000 });
        return page.locator('#storybook-root').innerHTML();
    };

    beforeAll(async () => {
        fx = makeFixture({ builder });
        const port = await freePort();
        base = `http://127.0.0.1:${port}`;
        sb = spawn(join(fx.hub, 'node_modules/.bin/storybook'), ['dev', '-p', String(port), '--host', '127.0.0.1', '--ci', '--no-open'], {
            cwd: fx.hub,
            env: { ...process.env, STORYBOOK_DISABLE_TELEMETRY: '1', NO_COLOR: '1' }
        });
        sb.stdout!.on('data', d => (log += d));
        sb.stderr!.on('data', d => (log += d));
        await until(async () => /storyhub: \d+ branch/.test(log) && (await fetch(`${base}/__storyhub/branches.json`)).ok, 'storybook + storyhub to start', 120_000);
        browser = await chromium.launch();
    });

    afterAll(async () => {
        await browser?.close();
        sb?.kill('SIGTERM');
    });

    describe(`storyhub in a real Storybook (${builder})`, () => {
        it('shows branch sections first, each with only its affected stories, then the common stories', async () => {
            const page = await browser.newPage();
            await page.goto(`${base}/`);
            await until(async () => (await sidebar(page)).includes('⎇ feat-ui · deps changed, behind main'), 'branch sections in the sidebar');
            // DOM order is Storybook's (local first); storyhub reorders visually, so read on-screen positions
            const blocks = await page.$$eval('#storybook-explorer-tree > div', els =>
                els
                    .map(e => ({
                        title: e.getAttribute('data-title') ?? (e.getAttribute('aria-label') ? null : 'Common'),
                        top: e.getBoundingClientRect().top,
                        // component nodes only: which story leaves are expanded depends on the initial selection
                        text: [...e.querySelectorAll('[data-nodetype="component"]')].map(n => (n as HTMLElement).innerText.trim())
                    }))
                    .filter(b => b.title)
                    .sort((a, b) => a.top - b.top)
                    .map(({ title, text }) => [title, text])
            );
            expect(blocks).toEqual([
                ['⎇ feat-button', ['Button', 'Card']],
                ['⎇ feat-label', ['Card']],
                ['⎇ feat-new', ['Chip']],
                ['⎇ feat-theme', ['Button', 'Card']],
                ['⎇ feat-ui · deps changed, behind main', ['Panel']],
                ['Common', ['Badge', 'Button', 'Card', 'Late', 'Panel']]
            ]);
            expect(await page.evaluate(() => getComputedStyle(document.querySelector('#storybook-explorer-tree > div:not([data-title]):not([aria-label])')!, '::before').content)).toBe('"Common"');
            await page.close();
        });

        it('renders each branch with its worktree changes while the hub stays unchanged', async () => {
            const page = await browser.newPage();
            const card = '/iframe.html?id=components-card--default&viewMode=story';
            expect(await renderedRoot(page, card, '[data-testid=card]')).toContain('Go v1');
            // a story main added after the branches split keeps working in the hub
            expect(await renderedRoot(page, '/iframe.html?id=components-late--default&viewMode=story', '[data-testid=late]')).toContain('Late v1');
            const btn = await renderedRoot(page, `/__storyhub/feat-button${card}`, '[data-testid=card]');
            expect(btn).toContain('Go v2');
            expect(btn).toContain('label:card');
            expect(btn).toContain('data-theme="dark"'); // context from the hub preview decorator still applies
            const label = await renderedRoot(page, `/__storyhub/feat-label${card}`, '[data-testid=card]');
            expect(label).toContain('LABEL:card');
            expect(label).toContain('Go v1');
            expect(await renderedRoot(page, '/__storyhub/feat-new/iframe.html?id=components-chip--default&viewMode=story', '[data-testid=chip]')).toContain('chip');
            expect(await renderedRoot(page, '/__storyhub/feat-ui/iframe.html?id=components-panel--default&viewMode=story', '[data-testid=box]')).toContain('data-version="2"');
            // feat-theme changes the module the preview's ThemeContext provider comes from; the branch
            // loads its own preview, so the provider still reaches the branch's consumers
            expect(await renderedRoot(page, '/__storyhub/feat-theme/iframe.html?id=components-button--primary&viewMode=story', '[data-testid=button]')).toContain('data-theme="dark"');
            expect(await renderedRoot(page, '/iframe.html?id=components-button--primary&viewMode=story', '[data-testid=button]')).toContain('data-theme="dark"');
            await page.close();
        });

        // Vite serves one request per module; webpack bundles them, so this check is Vite-only
        // (the shared ThemeContext assertion above covers module sharing for both)
        it.runIf(builder === 'vite')('loads only dirty modules from the worktree and shares the rest with the hub', async () => {
            const page = await browser.newPage();
            const urls: string[] = [];
            page.on('request', r => urls.push(decodeURIComponent(r.url())));
            await renderedRoot(page, '/__storyhub/feat-button/iframe.html?id=components-card--default&viewMode=story', '[data-testid=card]');
            const fromWorktree = urls.filter(u => u.includes(`${fx.worktrees['feat-button']}/`)).map(u => u.split(`${fx.worktrees['feat-button']}/`)[1].split('?')[0]);
            expect(new Set(fromWorktree)).toEqual(new Set(['src/components/Card.stories.tsx', 'src/components/Card.tsx', 'src/components/Button.tsx']));
            expect(urls.some(u => u.includes('/src/components/Label.tsx') && !u.includes('/feat-button/'))).toBe(true);
            await page.close();
        });

        it('shows a branch story inside the manager in its own ref iframe', async () => {
            const page = await browser.newPage();
            await page.goto(`${base}/?path=/story/feat-button_components-button--primary`);
            const frame = await until(async () => page.frames().find(f => f.url().includes('/__storyhub/feat-button/iframe.html')), 'ref iframe');
            await frame.waitForSelector('[data-testid=button]', { timeout: 20_000 });
            expect(await frame.locator('[data-testid=button]').innerText()).toBe('Primary v2');
            await page.close();
        });

        it('hot-updates a branch story when a worktree file is edited', async () => {
            const page = await browser.newPage();
            await renderedRoot(page, '/__storyhub/feat-button/iframe.html?id=components-button--primary&viewMode=story', '[data-testid=button]');
            await page.evaluate(() => ((window as unknown as { storyhubMarker: number }).storyhubMarker = 42));
            const file = join(fx.worktrees['feat-button'], 'src/components/Button.tsx');
            writeFileSync(file, readFileSync(file, 'utf8').replace('{label} v2', '{label} v3'));
            await until(async () => (await page.locator('[data-testid=button]').innerText()) === 'Primary v3', 'HMR update');
            expect(await page.evaluate(() => (window as unknown as { storyhubMarker?: number }).storyhubMarker)).toBe(42); // no full reload
            await page.close();
        });

        it('switches a rendered file to the worktree copy when an edit makes it branch-served', async () => {
            // feat-theme's Card renders the hub's Label (Label is not dirty there); editing Label in
            // that worktree changes the branch's structure, and the open iframe must pick it up
            const page = await browser.newPage();
            await renderedRoot(page, '/__storyhub/feat-theme/iframe.html?id=components-card--default&viewMode=story', '[data-testid=card]');
            expect(await page.locator('[data-testid=label]').innerText()).toBe('label:card');
            const file = join(fx.worktrees['feat-theme'], 'src/components/Label.tsx');
            writeFileSync(file, readFileSync(file, 'utf8').replace('label:{text}', 'label9:{text}'));
            await until(async () => (await page.locator('[data-testid=label]').innerText({ timeout: 1000 }).catch(() => '')) === 'label9:card', 'branch iframe to render the worktree Label', 60_000);
            await page.close();
        });

        it('adds stories to a branch section when an edit makes them affected', async () => {
            const page = await browser.newPage();
            await page.goto(`${base}/`);
            await until(async () => (await sidebar(page)).includes('⎇ feat-button'), 'sidebar');
            writeFileSync(join(fx.worktrees['feat-button'], 'src/components/Badge.tsx'), `import React from 'react';\nexport const Badge = () => <em data-testid="badge">badge v2</em>;\n`);
            await until(async () => Object.keys(await branchIndex('feat-button')).includes('components-badge--default'), 'Badge in feat-button index');
            await until(async () => {
                const l = await sidebar(page);
                const start = l.indexOf('⎇ feat-button');
                return l.slice(start, l.indexOf('⎇ feat-label')).includes('Badge');
            }, 'Badge in the feat-button sidebar section');
            expect(await renderedRoot(page, '/__storyhub/feat-button/iframe.html?id=components-badge--default&viewMode=story', '[data-testid=badge]')).toContain('badge v2');
            await page.close();
        });

        it('shows a new worktree only once `storyhub on` is run in it, and hides it with `storyhub off`', async () => {
            const page = await browser.newPage();
            await page.goto(`${base}/`);
            await until(async () => (await sidebar(page)).includes('⎇ feat-button'), 'sidebar');
            const wt = join(fx.dir, 'feat-live');
            runGit(fx.hub, 'worktree', 'add', '-q', '-b', 'feat-live', wt);
            writeFileSync(join(wt, 'src/components/Badge.tsx'), `import React from 'react';\nexport const Badge = () => <em data-testid="badge">live badge</em>;\n`);
            await new Promise(r => setTimeout(r, 1500));
            expect((await branches()).some(b => b.id === 'feat-live')).toBe(false); // opt-in: not shown yet

            // what an agent working in that worktree runs
            const cli = (...args: string[]) => execFileSync(process.execPath, [join(fx.hub, 'node_modules/storyhub/dist/cli.js'), ...args], { cwd: wt, encoding: 'utf8' });
            expect(cli('on')).toContain('on   feat-live');
            await until(async () => (await branches()).some(b => b.id === 'feat-live' && b.affectedStories === 1), 'feat-live branch');
            await until(async () => (await sidebar(page)).includes('⎇ feat-live'), 'feat-live section');
            expect(await renderedRoot(page, '/__storyhub/feat-live/iframe.html?id=components-badge--default&viewMode=story', '[data-testid=badge]')).toContain('live badge');

            const warnings: string[] = [];
            page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && warnings.push(m.text().slice(0, 400)));
            page.on('pageerror', e => warnings.push(`pageerror: ${String(e.stack ?? e).slice(0, 800)}`));
            await page.goto(`${base}/`);
            await until(async () => (await sidebar(page)).includes('⎇ feat-live'), 'feat-live section after reload').catch(async err => {
                const refs = await page.evaluate(() => Object.keys((window as unknown as { REFS?: object }).REFS ?? {}));
                const tree = await page.locator('#storybook-explorer-tree').count();
                const text = tree ? await page.locator('#storybook-explorer-tree').innerText({ timeout: 2000 }).catch(() => '?') : '(no explorer tree)';
                throw new Error(`${err.message.split('\n')[0]}\nsidebar: ${text.replace(/\n/g, ' | ')}\nREFS: ${refs}\nconsole: ${warnings.join(' || ')}`);
            });
            expect(cli('off')).toContain('off  feat-live');
            await until(async () => !(await branches()).some(b => b.id === 'feat-live'), 'feat-live hidden');
            await until(async () => !(await sidebar(page)).includes('⎇ feat-live'), 'feat-live section removed');
            runGit(fx.hub, 'worktree', 'remove', '--force', wt);
            await page.close();
        });

        it('registers itself so the CLI finds the checkout and URL without being told', () => {
            const cliPath = join(fx.hub, 'node_modules/storyhub/dist/cli.js');
            const cwd = fx.worktrees['feat-button'];
            const run = (...args: string[]) => execFileSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8' });
            const list = JSON.parse(run('list', '--json')) as { servers: Array<{ root: string; url: string }>; worktrees: Array<{ path: string; storybook: unknown }> };
            expect(list.servers.map(x => x.url)).toContain(base);
            expect(list.worktrees.find(w => w.path === fx.hub)?.storybook).toBe(base);
            // no --url: status finds the running Storybook on its own
            const status = JSON.parse(run('status', '--json')) as { source: string; branches: Array<{ id: string }> };
            expect(status.source).toBe('server');
            expect(status.branches.map(b => b.id)).toContain('feat-button');
        });

        it('answers MCP tool calls about branches and story variants', async () => {
            const client = new Client({ name: 'storyhub-e2e', version: '0.0.0' });
            await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/storyhub/mcp`)));
            const tools = (await client.listTools()).tools.map(t => t.name).sort();
            expect(tools).toEqual(['get-branch-changes', 'get-story-variants', 'list-branches', 'list-worktrees']);

            const list = toolJson(await client.callTool({ name: 'list-branches', arguments: {} }));
            expect(list.branches.map((b: { id: string }) => b.id)).toEqual(expect.arrayContaining(['feat-button', 'feat-label', 'feat-new', 'feat-theme', 'feat-ui']));

            const changes = toolJson(await client.callTool({ name: 'get-branch-changes', arguments: { branch: 'feat-label' } }));
            expect(changes.changes).toEqual([{ rel: 'src/components/Label.tsx', kind: 'M' }]);
            expect(changes.affected[0]).toMatchObject({
                file: 'src/components/Card.stories.tsx',
                reason: ['src/components/Card.stories.tsx', 'src/components/Card.tsx', 'src/components/Label.tsx'],
                stories: [{ id: 'components-card--default', managerUrl: `${base}/?path=/story/feat-label_components-card--default` }]
            });

            const variants = toolJson(await client.callTool({ name: 'get-story-variants', arguments: { storyId: 'components-card--default' } }));
            expect(variants.hub.iframeUrl).toBe(`${base}/iframe.html?id=components-card--default&viewMode=story`);
            expect(variants.variants.map((v: { branch: string }) => v.branch).sort()).toEqual(['feat-button', 'feat-label', 'feat-theme']);
            const page = await browser.newPage();
            await page.goto(variants.variants.find((v: { branch: string }) => v.branch === 'feat-label').iframeUrl);
            await page.waitForSelector('[data-testid=label]');
            expect(await page.locator('[data-testid=label]').innerText()).toBe('LABEL:card');
            await page.close();

            const unknown = await client.callTool({ name: 'get-branch-changes', arguments: { branch: 'nope' } });
            expect(unknown.isError).toBe(true);
            await client.close();
        });
    });
}

for (const builder of ['vite', 'webpack'] as const) suite(builder);
