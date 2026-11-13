import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPreviewOrConfigFile, normalizeStories } from 'storybook/internal/common';
import type { InlineConfig, ViteDevServer } from 'vite';
import type { Configuration } from 'webpack';
import type { StoryHub } from './core/state.js';
import type { BranchSummary } from './core/types.js';
import { isNodeModules, realpath, relInside } from './core/paths.js';
import { isSelected, readSelection, type SelectionOptions } from './core/selection.js';
import { gitCommonDir, registerServer } from './core/servers.js';
import { ROOT_ENV } from './core/tailwind.js';
import { gitToplevel, listWorktrees } from './core/worktrees.js';
import { createMcpHandler } from './mcp/server.js';
import { buildBranchIndex, isStoryFileFor, type IndexContext, type StoryIndex } from './server/branchIndex.js';
import { refusal, type AllowedHosts } from './server/guard.js';

export const REF_BASE = '/__storyhub';
export const MCP_PATH = '/storyhub/mcp';
export const BRANCHES_EVENT = 'storyhub/branches-changed';

const version: string = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;

/* Minimal views of Storybook's preset API, so this file doesn't depend on internal types. */
interface Presets {
    apply<T = unknown>(name: string, initial?: unknown, options?: unknown): Promise<T>;
}
interface PresetOptions {
    configDir: string;
    configType?: 'DEVELOPMENT' | 'PRODUCTION';
    presets: Presets;
    port?: number;
    https?: boolean;
    [key: string]: unknown;
}
interface Channel {
    emit(event: string, ...args: unknown[]): void;
}
type Next = (err?: unknown) => void;
interface App {
    use(handler: (req: IncomingMessage, res: ServerResponse, next: Next) => unknown): unknown;
}

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}
const deferred = <T>(): Deferred<T> => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => (resolve = r));
    return { promise, resolve };
};

interface Session {
    hub: Deferred<StoryHub>;
    server?: ViteDevServer;
    ctx?: Promise<IndexContext>;
}
const sessions = new Map<string, Session>();
const session = (configDir: string): Session => {
    let s = sessions.get(configDir);
    if (!s) sessions.set(configDir, (s = { hub: deferred() }));
    return s;
};

const isDev = (options: PresetOptions) => options.configType === 'DEVELOPMENT';

function indexContext(options: PresetOptions): Promise<IndexContext> {
    const s = session(options.configDir);
    s.ctx ??= (async () => {
        const gitRoot = await gitToplevel(options.configDir);
        const stories = await options.presets.apply('stories', [], options);
        const workingDir = process.cwd();
        const specifiers = normalizeStories(stories as never, { configDir: options.configDir, workingDir }) as unknown as IndexContext['specifiers'];
        return { gitRoot, workingDir, specifiers };
    })();
    return s.ctx;
}

const refTitle = (branch: string | null, fallback: string) => `⎇ ${branch ?? fallback}`;

/** Addon options `mode`, `include`, `exclude` (see selection.ts); git config adds to them. */
const selectionOptions = (options: PresetOptions): SelectionOptions => ({
    mode: options.mode === 'all' ? 'all' : 'opt-in',
    include: Array.isArray(options.include) ? (options.include as string[]) : [],
    exclude: Array.isArray(options.exclude) ? (options.exclude as string[]) : []
});

// The manager entry is picked up by Storybook's addon convention (the package's `./manager` export).

/**
 * Sidebar order. Storybook always renders local stories before composed refs, so branch sections
 * are moved with flexbox `order`: each branch ref renders as a header div (aria-label contains the
 * ⎇ title) plus a content div (data-title is the ⎇ title); the hub's own section is the one div
 * with neither attribute. Only visual order changes; DOM and keyboard order stay Storybook's.
 */
export function sidebarCss(position: 'top' | 'bottom', commonLabel: string): string {
    const hub = '#storybook-explorer-tree > div:not([data-title]):not([aria-label])';
    const branch = '#storybook-explorer-tree > div:is([data-title^="⎇"], [aria-label*="⎇"])';
    const label = JSON.stringify(commonLabel);
    return `
#storybook-explorer-tree { display: flex; flex-direction: column; }
${position === 'top' ? branch : hub} { order: -1; }
${position === 'top' ? `${hub}::before { content: ${label}; display: block; font-weight: 700; font-size: 13px; line-height: 16px; margin-top: 16px; padding: 20px 0 8px 20px; border-top: 1px solid rgba(128, 128, 128, 0.2); }` : ''}
`;
}

export const managerHead = async (head: string | undefined, options: PresetOptions) => {
    if (!isDev(options)) return head ?? '';
    const position = options.branchesPosition === 'bottom' ? 'bottom' : 'top';
    const label = typeof options.commonLabel === 'string' ? options.commonLabel : 'Common';
    return `${head ?? ''}\n<style data-storyhub>${sidebarCss(position, label)}</style>`;
};

/** One composition ref per worktree, served by this same dev server. */
export const refs = async (existing: Record<string, unknown> = {}, options: PresetOptions) => {
    if (!isDev(options)) return existing;
    let worktrees;
    let selection;
    try {
        const root = await gitToplevel(options.configDir);
        [worktrees, selection] = await Promise.all([listWorktrees(root), readSelection(root, selectionOptions(options))]);
    } catch {
        return existing;
    }
    const out: Record<string, unknown> = { ...existing };
    for (const wt of worktrees) {
        if (!isSelected(wt, selection)) continue;
        out[wt.id] = { title: refTitle(wt.branch, basename(wt.path)), url: `${REF_BASE}/${wt.id}`, expanded: true };
    }
    return out;
};

export const viteFinal = async (config: InlineConfig, options: PresetOptions) => {
    if (!isDev(options)) return config;
    const ctx = await indexContext(options).catch(() => null);
    if (!ctx) return config; // not a git checkout: stay out of the way
    const s = session(options.configDir);
    // loaded on demand so webpack projects never import vite (and vice versa)
    const { storyhubVitePlugin } = await import('./vite/plugin.js');
    process.env[ROOT_ENV] ??= ctx.gitRoot; // switches on withStoryhub (storyhub/tailwind)
    const plugins = storyhubVitePlugin({
        gitRoot: ctx.gitRoot,
        configDir: options.configDir,
        isStoryFile: isStoryFileFor(ctx),
        previewFiles: await projectPreviewFiles(options, ctx.gitRoot),
        selection: selectionOptions(options),
        refBase: REF_BASE,
        log: msg => console.log(msg),
        onHub: (hub, server) => {
            s.server = server;
            s.hub.resolve(hub);
        }
    });
    return { ...config, plugins: [...(config.plugins ?? []), ...plugins] };
};

/** The project's own preview annotation files (not addons'), git-root relative. */
async function projectPreviewFiles(options: PresetOptions, gitRoot: string): Promise<string[]> {
    const entries: unknown[] = [...((await options.presets.apply<unknown[]>('previewAnnotations', [], options).catch(() => [])) ?? [])];
    entries.push(loadPreviewOrConfigFile({ configDir: options.configDir }));
    const out = new Set<string>();
    for (const entry of entries) {
        const abs = typeof entry === 'string' ? entry : (entry as { absolute?: string } | undefined)?.absolute;
        if (!abs || isNodeModules(abs)) continue;
        const rel = relInside(gitRoot, realpath(abs));
        if (rel) out.add(rel);
    }
    return [...out];
}

export const webpackFinal = async (config: Configuration, options: PresetOptions) => {
    if (!isDev(options)) return config;
    const ctx = await indexContext(options).catch(() => null);
    if (!ctx) return config; // not a git checkout: stay out of the way
    const s = session(options.configDir);
    const { storyhubWebpackFinal } = await import('./webpack/plugin.js');
    process.env[ROOT_ENV] ??= ctx.gitRoot; // switches on withStoryhub (storyhub/tailwind)
    return storyhubWebpackFinal(config, {
        gitRoot: ctx.gitRoot,
        configDir: options.configDir,
        isStoryFile: isStoryFileFor(ctx),
        previewFiles: await projectPreviewFiles(options, ctx.gitRoot),
        selection: selectionOptions(options),
        refBase: REF_BASE,
        log: msg => console.log(msg),
        onHub: hub => s.hub.resolve(hub)
    });
};

async function hubIndex(options: PresetOptions): Promise<StoryIndex> {
    const generator = await options.presets.apply<{ getIndex(): Promise<StoryIndex> }>('storyIndexGenerator');
    return generator.getIndex();
}

async function branchIndex(options: PresetOptions, id: string): Promise<StoryIndex | null> {
    const hub = await session(options.configDir).hub.promise;
    const branch = hub.branches.get(id);
    if (!branch) return null;
    return buildBranchIndex(await indexContext(options), branch, await hubIndex(options));
}

/** Origin for URLs handed to the browser or an agent. Only used after the Host header passed the guard. */
const originOf = (options: PresetOptions, req: IncomingMessage) => `${options.https ? 'https' : 'http'}://${req.headers.host ?? `localhost:${options.port ?? 6006}`}`;

/** The server's own address, for requests storyhub makes to itself. Never taken from request headers. */
const selfOrigin = (options: PresetOptions) => {
    const host = !options.host || options.host === '0.0.0.0' || options.host === '::' ? 'localhost' : String(options.host);
    return `${options.https ? 'https' : 'http'}://${host.includes(':') ? `[${host}]` : host}:${options.port ?? 6006}`;
};

/** Hostnames allowed besides IPs and localhost: the `allowedHosts` option plus Storybook's own --host. */
const allowedHostsOf = (options: PresetOptions): AllowedHosts => {
    const opt = options.allowedHosts;
    if (opt === true) return true;
    const list = Array.isArray(opt) ? opt.filter((h): h is string => typeof h === 'string') : [];
    if (typeof options.host === 'string' && options.host) list.push(options.host);
    return list;
};

/** A value safe to place inside an inline <script>. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

/** Injected into each branch iframe: reload when the branch's structure (dirty/affected sets) changes. */
/**
 * Injected into each branch iframe: reload when that branch's structure changes. Uses a plain
 * server-sent event stream so it works the same with every builder.
 */
const reloadSnippet = (id: string) => `<script>
(function () {
  if (typeof EventSource === 'undefined') return;
  var source = new EventSource('${REF_BASE}/events');
  source.addEventListener('reload', function (e) {
    try { if (JSON.parse(e.data).ids.indexOf(${scriptJson(id)}) !== -1) location.reload(); } catch (err) { /* ignore malformed events */ }
  });
})();
</script>`;

/** Open server-sent event streams (branch iframes waiting for reload signals). */
const eventClients = new Set<ServerResponse>();
const broadcast = (event: string, data: unknown) => {
    for (const res of eventClients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
};

export const experimental_devServer = async (app: App, options: PresetOptions) => {
    if (!isDev(options)) return app;
    const s = session(options.configDir);
    const allowedHosts = allowedHostsOf(options);
    const mcp = createMcpHandler({
        getHub: () => s.hub.promise,
        getHubIndex: () => hubIndex(options),
        getBranchIndex: id => branchIndex(options, id),
        origin: req => originOf(options, req),
        version,
        refBase: REF_BASE,
        allowedHosts,
        // pass @storybook/addon-mcp through (default endpoint /mcp); `upstreamMcp: false` turns it off
        upstreamUrl: () => (options.upstreamMcp === false ? null : `${selfOrigin(options)}${typeof options.upstreamMcp === 'string' ? options.upstreamMcp : '/mcp'}`)
    });

    const handle = async (req: IncomingMessage, res: ServerResponse, next: Next) => {
        try {
            const url = new URL(req.url ?? '/', 'http://storyhub.local');
            if (url.pathname === MCP_PATH) return await mcp(req, res);
            if (!url.pathname.startsWith(`${REF_BASE}/`)) return next();
            const refused = refusal(req, allowedHosts);
            if (refused) return sendJson(res, 403, { error: refused });
            const rest = url.pathname.slice(REF_BASE.length + 1);
            if (rest === 'events') {
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
                res.write(': storyhub\n\n');
                eventClients.add(res);
                const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
                req.on('close', () => {
                    clearInterval(ping);
                    eventClients.delete(res);
                });
                return;
            }
            if (rest === 'branches.json') {
                const hub = await s.hub.promise;
                return sendJson(res, 200, { branches: hub.summaries() satisfies BranchSummary[] });
            }
            const slash = rest.indexOf('/');
            const id = slash === -1 ? rest : rest.slice(0, slash);
            const file = slash === -1 ? '' : rest.slice(slash + 1);
            if (file === 'index.json' || file === 'stories.json') {
                const index = await branchIndex(options, id);
                return index ? sendJson(res, 200, index) : sendJson(res, 404, { error: `unknown branch ${id}` });
            }
            if (file === 'metadata.json') return sendJson(res, 200, {});
            if (file === 'iframe.html') {
                if (!(await s.hub.promise).branches.has(id)) return sendJson(res, 404, { error: `unknown branch ${id}` });
                // same preview bundle as the hub; only the URL (and so ./index.json) differs
                const upstream = await fetch(`${selfOrigin(options)}/iframe.html${url.search}`);
                const html = (await upstream.text()).replace('</head>', `${reloadSnippet(id)}</head>`);
                res.writeHead(upstream.status, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
                return res.end(html);
            }
            // a branch preview link (/__storyhub/<id>/?path=/story/<story>) opens that story in the
            // branch's sidebar section; the same URL with iframe.html is what preview apps embed
            const storyPath = url.searchParams.get('path');
            if (file === '' && storyPath?.startsWith('/story/')) {
                url.searchParams.set('path', `/story/${id}_${storyPath.slice('/story/'.length)}`);
                res.writeHead(302, { Location: `/?${url.searchParams.toString().replace(/%2F/g, '/').replace(/%3A/g, ':').replace(/%3B/g, ';')}` });
                return res.end();
            }
            // anything else the preview asks for relatively (fonts, assets) lives at the root; leading
            // slashes are dropped so the target can never become another site ("//evil.example")
            res.writeHead(302, { Location: `/${file.replace(/^[/\\]+/, '')}${url.search}` });
            res.end();
        } catch (err) {
            if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            else res.end();
        }
    };
    // tell the CLI which checkout this Storybook runs from, and where to reach it
    void s.hub.promise
        .then(async hub => {
            registerServer(await gitCommonDir(hub.root), {
                root: hub.root,
                configDir: options.configDir,
                url: selfOrigin(options),
                version
            });
        })
        .catch(() => {});

    app.use((req, res, next) => {
        // handle() catches its own errors; this guards anything that still escapes
        handle(req, res, next).catch(() => {
            if (!res.headersSent) res.statusCode = 500;
            res.end();
        });
    });
    return app;
};

export const experimental_serverChannel = async (channel: Channel, options: PresetOptions) => {
    if (!isDev(options)) return channel;
    void session(options.configDir).hub.promise.then(hub => {
        hub.on('change', (summaries: BranchSummary[]) => channel.emit(BRANCHES_EVENT, summaries));
        hub.on('structure', (ids: string[]) => broadcast('reload', { ids }));
        hub.on('previews', () => broadcast('reload', { ids: [...hub.branches.keys()] }));
    });
    return channel;
};
