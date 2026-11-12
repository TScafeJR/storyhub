import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error untyped fixture script
import { runGit } from '../fixtures/create-fixture.mjs';
import { makeFixture, type Fixture } from '../helpers.js';

let fx: Fixture;
let sb: ChildProcess;
let base: string;
let browser: Browser;
let log = '';

const freePort = () =>
    new Promise<number>((resolve, reject) => {
        const srv = createServer();
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address() as { port: number };
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });

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

const sidebar = async (page: Page) => (await page.locator('#storybook-explorer-tree').innerText()).split('\n').map(s => s.trim()).filter(Boolean);

const renderedRoot = async (page: Page, path: string, selector: string) => {
    await page.goto(base + path);
    await page.waitForSelector(selector, { timeout: 20_000 });
    return page.locator('#storybook-root').innerHTML();
};

beforeAll(async () => {
    fx = makeFixture();
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

describe('storyhub in a real Storybook', () => {
    it('shows hub stories first, then one section per worktree listing only affected stories', async () => {
        const page = await browser.newPage();
        await page.goto(`${base}/`);
        const lines = await until(async () => {
            const l = await sidebar(page);
            return l.includes('⎇ feat-ui · deps changed') && l;
        }, 'branch sections in the sidebar');
        const sections = lines.filter(l => l.startsWith('⎇'));
        expect(sections).toEqual(['⎇ feat-button', '⎇ feat-label', '⎇ feat-new', '⎇ feat-ui · deps changed']);
        const after = (title: string) => {
            const start = lines.indexOf(title);
            const next = lines.findIndex((l, i) => i > start && l.startsWith('⎇'));
            return lines.slice(start + 1, next === -1 ? undefined : next).filter(l => l !== 'COMPONENTS');
        };
        expect(lines.indexOf('Badge')).toBeLessThan(lines.indexOf('⎇ feat-button'));
        expect(after('⎇ feat-button')).toEqual(['Button', 'Card']);
        expect(after('⎇ feat-label')).toEqual(['Card']);
        expect(after('⎇ feat-new')).toEqual(['Chip']);
        expect(after('⎇ feat-ui · deps changed')).toEqual(['Panel']);
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
        await page.close();
    });

    it('loads only dirty modules from the worktree and shares the rest with the hub', async () => {
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
        await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 42));
        const file = join(fx.worktrees['feat-button'], 'src/components/Button.tsx');
        writeFileSync(file, (await import('node:fs')).readFileSync(file, 'utf8').replace('{label} v2', '{label} v3'));
        await until(async () => (await page.locator('[data-testid=button]').innerText()) === 'Primary v3', 'HMR update');
        expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(42); // no full reload
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

    it('picks up worktrees added and removed while running', async () => {
        const page = await browser.newPage();
        await page.goto(`${base}/`);
        await until(async () => (await sidebar(page)).includes('⎇ feat-button'), 'sidebar');
        const wt = join(fx.dir, 'feat-live');
        runGit(fx.hub, 'worktree', 'add', '-q', '-b', 'feat-live', wt);
        writeFileSync(join(wt, 'src/components/Badge.tsx'), `import React from 'react';\nexport const Badge = () => <em data-testid="badge">live badge</em>;\n`);
        await until(async () => (await branches()).some(b => b.id === 'feat-live' && b.affectedStories === 1), 'feat-live branch');
        await until(async () => (await sidebar(page)).includes('⎇ feat-live'), 'feat-live section');
        expect(await renderedRoot(page, '/__storyhub/feat-live/iframe.html?id=components-badge--default&viewMode=story', '[data-testid=badge]')).toContain('live badge');

        await page.goto(`${base}/`);
        await until(async () => (await sidebar(page)).includes('⎇ feat-live'), 'feat-live section after reload');
        runGit(fx.hub, 'worktree', 'remove', '--force', wt);
        await until(async () => !(await branches()).some(b => b.id === 'feat-live'), 'feat-live removed');
        await until(async () => !(await sidebar(page)).includes('⎇ feat-live'), 'feat-live section removed');
        await page.close();
    });

    it('answers MCP tool calls about branches and story variants', async () => {
        const client = new Client({ name: 'storyhub-e2e', version: '0.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/storyhub/mcp`)));
        const tools = (await client.listTools()).tools.map(t => t.name).sort();
        expect(tools).toEqual(['get-branch-changes', 'get-story-variants', 'list-branches']);

        const text = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);
        const list = text(await client.callTool({ name: 'list-branches', arguments: {} }));
        expect(list.branches.map((b: { id: string }) => b.id)).toEqual(expect.arrayContaining(['feat-button', 'feat-label', 'feat-new', 'feat-ui']));

        const changes = text(await client.callTool({ name: 'get-branch-changes', arguments: { branch: 'feat-label' } }));
        expect(changes.changes).toEqual([{ rel: 'src/components/Label.tsx', kind: 'M' }]);
        expect(changes.affected[0]).toMatchObject({
            file: 'src/components/Card.stories.tsx',
            reason: ['src/components/Card.stories.tsx', 'src/components/Card.tsx', 'src/components/Label.tsx'],
            stories: [{ id: 'components-card--default', managerUrl: `${base}/?path=/story/feat-label_components-card--default` }]
        });

        const variants = text(await client.callTool({ name: 'get-story-variants', arguments: { storyId: 'components-card--default' } }));
        expect(variants.hub.iframeUrl).toBe(`${base}/iframe.html?id=components-card--default&viewMode=story`);
        expect(variants.variants.map((v: { branch: string }) => v.branch).sort()).toEqual(['feat-button', 'feat-label']);
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
