import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Renders stories in headless Chromium and reports what Storybook's preview says about them: the
 * play function outcome, render errors, and any reports (addon-a11y posts its results there).
 *
 * This is how branch stories get tested: addon-vitest only runs the hub's story files, while a
 * branch iframe renders the branch's code. Playwright is taken from the project (addon-vitest
 * already requires it), so storyhub still has no dependencies of its own.
 */

export interface A11yViolation {
    id: string;
    impact: string | null;
    help: string;
    nodes: number;
}

export interface StoryRun {
    storyId: string;
    status: 'passed' | 'failed' | 'missing' | 'timeout';
    error?: string;
    a11y?: { status: string; violations: A11yViolation[] };
}

interface PageLike {
    addInitScript(script: string): Promise<void>;
    goto(url: string, opts?: { timeout?: number }): Promise<unknown>;
    waitForFunction(fn: string, arg?: unknown, opts?: { timeout?: number }): Promise<unknown>;
    evaluate<T>(fn: string): Promise<T>;
    close(): Promise<void>;
}
interface BrowserLike {
    newContext(): Promise<{ newPage(): Promise<PageLike>; close(): Promise<void> }>;
    close(): Promise<void>;
}

let browser: Promise<BrowserLike> | undefined;

async function loadChromium(): Promise<{ launch(opts: { headless: boolean }): Promise<BrowserLike> }> {
    const bases = [join(process.cwd(), 'package.json'), import.meta.url];
    for (const base of bases) {
        const req = createRequire(base);
        for (const pkg of ['playwright', 'playwright-core', '@playwright/test']) {
            try {
                const mod = (await import(pathToFileURL(req.resolve(pkg)).href)) as { chromium?: { launch(opts: { headless: boolean }): Promise<BrowserLike> }; default?: { chromium?: unknown } };
                const chromium = mod.chromium ?? (mod.default as { chromium?: typeof mod.chromium } | undefined)?.chromium;
                if (chromium) return chromium;
            } catch {
                // try the next one
            }
        }
    }
    throw new Error('Testing branch stories needs Playwright in this project: npm install -D playwright && npx playwright install chromium');
}

function getBrowser(): Promise<BrowserLike> {
    browser ??= (async () => {
        const chromium = await loadChromium();
        try {
            const b = await chromium.launch({ headless: true });
            process.once('exit', () => void b.close());
            return b;
        } catch (err) {
            browser = undefined;
            throw new Error(`Could not start Chromium for story tests (${(err as Error).message.split('\n')[0]}). Run: npx playwright install chromium`, { cause: err });
        }
    })();
    return browser;
}

/** Captures the preview's events from the moment Storybook creates its channel. */
const CAPTURE = `(() => {
  const state = (window.__storyhubTest = { events: [] });
  const watched = ['storyFinished', 'playFunctionThrewException', 'storyThrewException', 'storyErrored', 'storyMissing', 'unhandledErrorsWhilePlaying'];
  let channel;
  Object.defineProperty(window, '__STORYBOOK_ADDONS_CHANNEL__', {
    configurable: true,
    get() { return channel; },
    set(value) {
      channel = value;
      for (const ev of watched) value.on(ev, payload => state.events.push({ ev, payload }));
    }
  });
})();`;

const DONE = `window.__storyhubTest && window.__storyhubTest.events.some(e => ['storyFinished', 'storyMissing', 'storyErrored'].includes(e.ev))`;

const describe = (payload: unknown): string => {
    if (!payload) return '';
    if (typeof payload === 'string') return payload;
    const p = payload as { message?: string; description?: string; title?: string; name?: string };
    return [p.name && p.name !== 'Error' ? p.name : '', p.message ?? p.title ?? '', p.description ?? ''].filter(Boolean).join(': ');
};

async function runOne(context: { newPage(): Promise<PageLike> }, storyId: string, url: string, timeoutMs: number): Promise<StoryRun> {
    const page = await context.newPage();
    try {
        await page.addInitScript(CAPTURE);
        await page.goto(url, { timeout: timeoutMs });
        try {
            await page.waitForFunction(DONE, undefined, { timeout: timeoutMs });
        } catch {
            return { storyId, status: 'timeout', error: `no result within ${Math.round(timeoutMs / 1000)}s` };
        }
        const events = await page.evaluate<Array<{ ev: string; payload: unknown }>>('window.__storyhubTest.events');
        if (events.some(e => e.ev === 'storyMissing')) return { storyId, status: 'missing', error: 'story not found in this index' };
        const finished = events.find(e => e.ev === 'storyFinished')?.payload as { status?: string; reporters?: Array<{ type: string; status: string; result?: { violations?: Array<{ id: string; impact?: string | null; help: string; nodes?: unknown[] }> } }> } | undefined;
        const errors = events.filter(e => e.ev !== 'storyFinished').map(e => describe(Array.isArray(e.payload) ? e.payload[0] : e.payload)).filter(Boolean);
        const a11yReport = finished?.reporters?.find(r => r.type === 'a11y');
        // In dev, Storybook still finishes a story with status 'success' after its play function
        // throws (the throw is reported as its own event), so any reported error fails the run.
        const run: StoryRun = { storyId, status: finished?.status === 'success' && errors.length === 0 && !events.some(e => e.ev === 'storyErrored') ? 'passed' : 'failed' };
        if (errors.length) run.error = errors.join('\n');
        if (a11yReport) {
            run.a11y = {
                status: a11yReport.status,
                violations: (a11yReport.result?.violations ?? []).map(v => ({ id: v.id, impact: v.impact ?? null, help: v.help, nodes: v.nodes?.length ?? 0 }))
            };
        }
        if (run.status === 'failed' && !run.error) run.error = a11yReport?.status === 'failed' ? 'accessibility checks failed' : 'the story reported an error';
        return run;
    } finally {
        await page.close();
    }
}

/** Runs each story at its iframe URL, a few at a time. */
export async function runStories(targets: Array<{ storyId: string; url: string }>, opts: { timeoutMs?: number; concurrency?: number } = {}): Promise<StoryRun[]> {
    const context = await (await getBrowser()).newContext();
    const results: StoryRun[] = Array.from({ length: targets.length });
    let next = 0;
    const worker = async () => {
        while (next < targets.length) {
            const i = next++;
            results[i] = await runOne(context, targets[i].storyId, targets[i].url, opts.timeoutMs ?? 30_000).catch(err => ({ storyId: targets[i].storyId, status: 'failed' as const, error: String(err?.message ?? err) }));
        }
    };
    try {
        await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, targets.length) }, worker));
    } finally {
        await context.close();
    }
    return results;
}
