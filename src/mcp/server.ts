import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StoryHub } from '../core/state.js';
import type { StoryIndex } from '../server/branchIndex.js';
import { formatOutcomes, previewUrl, resolveStories, testInBrowser, type ResolvedStory, type StoryContext, type StoryInput, type Unresolved } from './stories.js';
import { upstreamFor, type UpstreamInfo, type UpstreamMcp, type UpstreamTool } from './upstream.js';

/**
 * A minimal, dependency-free MCP server over Streamable HTTP in stateless JSON-response mode:
 * every POST carries JSON-RPC messages and gets a JSON reply; there are no sessions or SSE streams.
 *
 * It is meant to be the only MCP server an agent needs for Storybook: when @storybook/addon-mcp
 * runs on the same dev server, its tools, resources and prompts are passed through, and its story
 * preview and story test tools are replaced by versions that also understand branches.
 */

export interface McpDeps {
    getHub: () => Promise<StoryHub>;
    getHubIndex: () => Promise<StoryIndex>;
    getBranchIndex: (branchId: string) => Promise<StoryIndex | null>;
    /** Absolute origin agents should open URLs on, e.g. http://localhost:6006 */
    origin: (req: IncomingMessage) => string;
    version: string;
    /** URL of @storybook/addon-mcp's endpoint on this server, or null to not pass it through. */
    upstreamUrl?: (req: IncomingMessage) => string | null;
    refBase?: string;
}

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 1024 * 1024;

const DRIFT_HELP = {
    'deps-drift': 'package.json or a lockfile changed; the branch still renders with the hub dependencies',
    'config-drift': 'the Storybook config dir changed; the hub main config is used (preview files are applied per branch)',
    diverged: 'some files changed on both the hub and the branch since they split; the branch version wins',
    behind: 'main changed files the branch renders from its own older copy (see staleFiles); rebase or merge main to render them current',
    'missing-dep': 'the branch imports packages the hub cannot resolve; affected stories will error'
};

const INSTRUCTIONS =
    'storyhub renders opted-in git worktrees of this repo as branch sections in one Storybook ' +
    '(turn one on with `npx --no-install storyhub on` inside it; list-worktrees shows what is on). ' +
    'Branch sections only contain stories whose rendering that branch changes. Use list-branches first, ' +
    'get-branch-changes to see what a branch touched and why each story is affected, and get-story-variants ' +
    'to get side-by-side URLs (hub vs branches) for a story id. The story preview and story test tools accept a ' +
    '`branch` (or infer it from an absoluteStoryPath inside a worktree) to preview or test that branch\'s version; ' +
    'branch tests also run the story in Common and flag regressions. Without a branch they work on Common as usual.';

interface ToolResult {
    content: Array<{ type: 'text'; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
}
type JsonSchema = { type?: string; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown };
type ToolArgs = Record<string, unknown> & { branch?: string; storyId?: string; stories?: StoryInput[]; a11y?: boolean; compare?: boolean };
interface Tool {
    name: string;
    title: string;
    description: string;
    inputSchema: JsonSchema;
    outputSchema?: unknown;
    _meta?: Record<string, unknown>;
    run: (args: ToolArgs, origin: string) => Promise<unknown>;
}

interface Upstream {
    client: UpstreamMcp | null;
    info: UpstreamInfo | null;
}

const STORY_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        storyId: { type: 'string', description: 'Story id, e.g. "components-button--primary"' },
        absoluteStoryPath: { type: 'string', description: 'Absolute path of the .stories file (a path inside a worktree selects that branch)' },
        exportName: { type: 'string', description: 'Story export name, used with absoluteStoryPath' },
        props: { type: 'object', description: 'Args to preview with' },
        globals: { type: 'object', description: 'Globals to preview with' }
    }
};
const BRANCH_PROPERTY = {
    type: 'string',
    description:
        'storyhub: branch (worktree id from list-branches) to preview or test instead of Common. Optional: a story given by absoluteStoryPath inside a worktree selects that branch on its own.'
};

/** Adds storyhub's extra properties to a (possibly upstream) input schema without mutating it. */
const withProperties = (schema: JsonSchema, extra: Record<string, unknown>): JsonSchema => ({
    ...schema,
    type: 'object',
    properties: { ...schema.properties, ...extra }
});

const PREVIEW_NAMES = new Set(['preview-stories', 'stories-preview']);
const isUpstreamPreview = (t: UpstreamTool) => PREVIEW_NAMES.has(t.name) || t.title === 'Get story preview URLs';
const isUpstreamTest = (t: UpstreamTool) => t.name === 'run-story-tests' || t.title === 'Storybook Tests';

const json = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

const managerUrl = (origin: string, refId: string | null, storyId: string) => `${origin}/?path=/story/${refId ? `${refId}_` : ''}${storyId}`;
const iframeUrl = (origin: string, base: string, storyId: string) => `${origin}${base}/iframe.html?id=${encodeURIComponent(storyId)}&viewMode=story`;

async function storyContext(deps: McpDeps, origin: string): Promise<StoryContext> {
    const [hub, hubIndex] = await Promise.all([deps.getHub(), deps.getHubIndex()]);
    return { hub, hubIndex, branchIndex: deps.getBranchIndex, origin, refBase: deps.refBase ?? hub.refBase };
}

const isResolved = (r: ResolvedStory | Unresolved): r is ResolvedStory => 'storyId' in r;

/** Story preview URLs for Common or a branch, shaped like addon-mcp's tool so its preview app works. */
function previewTool(deps: McpDeps, up: Upstream): Tool {
    const upstream = up.info?.tools.find(isUpstreamPreview);
    return {
        name: upstream?.name ?? 'preview-stories',
        title: upstream?.title ?? 'Get story preview URLs',
        description:
            (upstream?.description ?? 'Get Storybook preview URLs for one or more stories. Include each URL in your response so the user can open it.') +
            '\nstoryhub: pass `branch`, or give a story by absoluteStoryPath inside a worktree, to preview that branch\'s version instead of Common.',
        inputSchema: withProperties((upstream?.inputSchema as JsonSchema) ?? { type: 'object', properties: { stories: { type: 'array', items: STORY_INPUT_SCHEMA } }, required: ['stories'] }, { branch: BRANCH_PROPERTY }),
        ...(upstream?.outputSchema ? { outputSchema: upstream.outputSchema } : {}),
        ...(upstream?._meta ? { _meta: upstream._meta } : {}),
        run: async (args, origin) => {
            const ctx = await storyContext(deps, origin);
            const resolved = await resolveStories(ctx, (args.stories as StoryInput[] | undefined) ?? [], args.branch);
            const stories = resolved.map(r =>
                isResolved(r) ? { title: r.entry.title, name: r.entry.name, previewUrl: previewUrl(ctx, r.branch, r.storyId, r.input) } : { input: r.input, error: r.error }
            );
            const text = stories.map(s => ('previewUrl' in s ? s.previewUrl : s.error));
            const branches = [...new Set(resolved.filter(isResolved).map(r => r.branch).filter(Boolean))];
            if (branches.length) text.push(`These URLs show branch ${branches.join(', ')}: the worktree's version of each story, opened in its branch section.`);
            return { content: text.map(t => ({ type: 'text', text: t })), structuredContent: { stories } };
        }
    };
}

/**
 * Story tests. Common stories go to addon-vitest through addon-mcp when it is available, exactly as
 * before. Branch stories (and Common ones without addon-vitest) are rendered in headless Chromium;
 * branch runs also run the story in Common so regressions are called out.
 */
function testTool(deps: McpDeps, up: Upstream): Tool {
    const upstream = up.info?.tools.find(isUpstreamTest);
    const base: JsonSchema = (upstream?.inputSchema as JsonSchema) ?? {
        type: 'object',
        properties: {
            stories: { type: 'array', items: STORY_INPUT_SCHEMA, description: 'Stories to test. Omit to test every story of the branch (or all of Common).' },
            a11y: { type: 'boolean', description: 'Report accessibility results when addon-a11y is installed. Defaults to true.' }
        }
    };
    return {
        name: upstream?.name ?? 'run-story-tests',
        title: upstream?.title ?? 'Storybook Tests',
        description:
            (upstream?.description ?? 'Run story tests: render each story, run its play function and report pass/fail (and accessibility results with addon-a11y).') +
            '\nstoryhub: pass `branch`, or give stories by absoluteStoryPath inside a worktree, to test that branch\'s version; each branch story is also run in Common and regressions are flagged. Omit stories with a branch to test every story the branch changes.',
        inputSchema: withProperties(base, {
            branch: BRANCH_PROPERTY,
            compare: { type: 'boolean', description: 'storyhub: for branch runs, also run each story in Common and flag regressions. Defaults to true.' }
        }),
        run: async (args, origin) => {
            const ctx = await storyContext(deps, origin);
            const inputs = args.stories as StoryInput[] | undefined;
            const a11y = args.a11y !== false;
            const compare = args.compare !== false;
            let resolved: Array<ResolvedStory | Unresolved>;
            if (inputs?.length) resolved = await resolveStories(ctx, inputs, args.branch);
            else if (args.branch) {
                const index = ctx.hub.branches.has(args.branch) ? await ctx.branchIndex(args.branch) : null;
                resolved = index
                    ? await resolveStories(ctx, Object.values(index.entries).filter(e => e.type === 'story').map(e => ({ storyId: e.id })), args.branch)
                    : await resolveStories(ctx, [{ storyId: '(all)' }], args.branch);
            } else resolved = [];

            const forBranches = resolved.filter(isResolved).filter(r => r.branch);
            const forCommon = resolved.filter(isResolved).filter(r => !r.branch);
            const errors = resolved.filter((r): r is Unresolved => !isResolved(r)).map(r => r.error);
            const sections: string[] = [];

            // Common: addon-vitest (via addon-mcp) when it is there, exactly as without storyhub
            if ((!inputs?.length && !args.branch) || forCommon.length) {
                if (upstream && up.client) {
                    const forwarded = (await up.client.request('tools/call', {
                        name: upstream.name,
                        arguments: { ...(forCommon.length ? { stories: forCommon.map(r => r.input) } : {}), a11y }
                    })) as { content?: Array<{ type: string; text?: string }> };
                    if (!forBranches.length && !errors.length) return forwarded;
                    sections.push((forwarded.content ?? []).map(c => c.text ?? '').join('\n'));
                } else if (forCommon.length) {
                    sections.push(formatOutcomes(await testInBrowser(ctx, forCommon, { a11y, compare: false })));
                } else if (!forBranches.length) {
                    errors.push('Name the stories to test, or a branch. (Testing all of Common at once needs @storybook/addon-vitest with @storybook/addon-mcp.)');
                }
            }
            let outcomes: Awaited<ReturnType<typeof testInBrowser>> = [];
            if (forBranches.length) {
                outcomes = await testInBrowser(ctx, forBranches, { a11y, compare });
                sections.push(formatOutcomes(outcomes));
            }
            if (errors.length) sections.push(errors.map(e => `! ${e}`).join('\n'));
            const failed = outcomes.some(o => o.status !== 'passed');
            return {
                content: [{ type: 'text', text: sections.join('\n\n') || 'Nothing to test.' }],
                structuredContent: { results: outcomes, errors, ...(failed ? { failed: true } : {}) }
            };
        }
    };
}

function tools(deps: McpDeps, up: Upstream): Tool[] {
    return [
        {
            name: 'list-branches',
            title: 'List worktree branches',
            description: 'Lists every git worktree rendered as a branch section, with drift flags and how many files and stories each one changes.',
            inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
            run: async (_args, origin) => {
                const hub = await deps.getHub();
                const branches = hub.summaries().map(s => ({ ...s, refUrl: `${origin}${s.refUrl}`, driftHelp: s.drift.map(d => DRIFT_HELP[d]) }));
                return json({ hubRoot: hub.root, hubStoryFiles: hub.hubStories.length, branches });
            }
        },
        {
            name: 'list-worktrees',
            title: 'List all worktrees and whether they are shown',
            description:
                'Lists every git worktree of the repo, including ones not shown in Storybook. Branches are opt-in: to show the worktree you are working in, run `npx --no-install storyhub on` inside it (and `npx --no-install storyhub off` to hide it again). If the worktree has no node_modules, run it from a checkout that has storyhub installed, with the branch name: `npx --no-install storyhub on <branch>`.',
            inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
            run: async () => {
                const hub = await deps.getHub();
                return json({
                    worktrees: hub.allWorktrees.map(w => ({ id: w.id, branch: w.branch, path: w.path, hub: w.isHub, shown: w.selected })),
                    howTo: {
                        show: 'cd <worktree> && npx --no-install storyhub on',
                        hide: 'cd <worktree> && npx --no-install storyhub off',
                        fromMainCheckout: 'npx --no-install storyhub on <branch>',
                        list: 'npx --no-install storyhub list'
                    }
                });
            }
        },
        {
            name: 'get-branch-changes',
            title: 'Get a branch’s changes and affected stories',
            description:
                'For one branch (worktree id from list-branches): changed files since its merge base with the hub, drift flags, and every affected story with the import chain that explains why it is affected, plus URLs to view it.',
            inputSchema: { type: 'object', properties: { branch: { type: 'string', description: 'Branch/worktree id from list-branches' } }, required: ['branch'], additionalProperties: false },
            run: async (args, origin) => {
                const branch = String(args.branch);
                const hub = await deps.getHub();
                const b = hub.branches.get(branch);
                if (!b) return fail(`Unknown branch "${branch}". Known: ${[...hub.branches.keys()].join(', ') || '(none)'}`);
                const index = await deps.getBranchIndex(branch);
                const base = `${hub.refBase}/${branch}`;
                const affected = b.affectedStories.map(file => ({
                    file,
                    reason: hub.reason(branch, file),
                    stories: Object.values(index?.entries ?? {})
                        .filter(e => e.type === 'story' && e.importPath.endsWith(`/${file}`))
                        .map(e => ({ id: e.id, title: e.title, name: e.name, managerUrl: managerUrl(origin, branch, e.id), iframeUrl: iframeUrl(origin, base, e.id) }))
                }));
                return json({
                    branch,
                    path: b.worktree.path,
                    mergeBase: b.mergeBase,
                    drift: b.drift.map(d => ({ flag: d, meaning: DRIFT_HELP[d] })),
                    diverged: b.diverged,
                    staleFiles: b.staleFiles,
                    missingDeps: b.missingDeps,
                    changes: b.changes,
                    affected,
                    ...(b.error ? { error: b.error } : {})
                });
            }
        },
        {
            name: 'get-story-variants',
            title: 'Get every rendering of a story',
            description:
                'Given a story id (e.g. "components-button--primary"), returns its URL in the hub plus the URL in every branch whose changes affect it, for side-by-side comparison or screenshots.',
            inputSchema: { type: 'object', properties: { storyId: { type: 'string', description: 'Story id as used in the hub, without any ref prefix' } }, required: ['storyId'], additionalProperties: false },
            run: async (args, origin) => {
                const storyId = String(args.storyId);
                const hub = await deps.getHub();
                const hubEntry = (await deps.getHubIndex()).entries[storyId];
                const variants = [];
                for (const b of hub.branches.values()) {
                    const entry = (await deps.getBranchIndex(b.worktree.id))?.entries[storyId];
                    if (!entry) continue;
                    const file = b.affectedStories.find(f => entry.importPath.endsWith(`/${f}`));
                    variants.push({
                        branch: b.worktree.id,
                        drift: b.drift,
                        reason: file ? hub.reason(b.worktree.id, file) : null,
                        managerUrl: managerUrl(origin, b.worktree.id, storyId),
                        iframeUrl: iframeUrl(origin, `${hub.refBase}/${b.worktree.id}`, storyId)
                    });
                }
                if (!hubEntry && !variants.length) return fail(`Story "${storyId}" is not in the hub or any branch.`);
                return json({
                    storyId,
                    hub: hubEntry ? { title: hubEntry.title, name: hubEntry.name, managerUrl: managerUrl(origin, null, storyId), iframeUrl: iframeUrl(origin, '', storyId) } : null,
                    variants
                });
            }
        },
        previewTool(deps, up),
        testTool(deps, up)
    ];
}

interface JsonRpcMessage {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
}

const rpcError = (id: JsonRpcMessage['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** Methods passed straight to addon-mcp when it is available. */
const FORWARDED = new Set(['resources/list', 'resources/templates/list', 'resources/read', 'prompts/list', 'prompts/get', 'completion/complete']);

/** Handles one JSON-RPC message; returns undefined for notifications. */
export async function handleMessage(deps: McpDeps, msg: JsonRpcMessage, origin: string, upstream: UpstreamMcp | null = null): Promise<object | undefined> {
    const isRequest = msg.id !== undefined && msg.id !== null;
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return isRequest ? rpcError(msg.id, -32600, 'Invalid Request') : undefined;
    if (!isRequest) return undefined; // notifications (initialized, cancelled, ...) need no reply
    const ok = (result: object) => ({ jsonrpc: '2.0', id: msg.id, result });
    const up: Upstream = { client: upstream, info: upstream && msg.method !== 'ping' ? await upstream.connect() : null };
    const toolList = tools(deps, up);
    const ours = new Set(toolList.map(t => t.name));

    switch (msg.method) {
        case 'initialize': {
            const requested = String(msg.params?.protocolVersion ?? '');
            const upCaps = up.info?.capabilities ?? {};
            return ok({
                protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
                capabilities: { tools: { listChanged: false }, ...(upCaps.resources ? { resources: {} } : {}), ...(upCaps.prompts ? { prompts: {} } : {}) },
                serverInfo: { name: 'storyhub', version: deps.version },
                instructions: up.info?.instructions ? `${INSTRUCTIONS}\n\n${up.info.instructions}` : INSTRUCTIONS
            });
        }
        case 'ping':
            return ok({});
        case 'tools/list': {
            const passed = (up.info?.tools ?? []).filter(t => !ours.has(t.name) && !isUpstreamPreview(t) && !isUpstreamTest(t));
            return ok({ tools: [...toolList.map(({ run: _run, ...t }) => t), ...passed] });
        }
        case 'tools/call': {
            const name = msg.params?.name;
            const tool = toolList.find(t => t.name === name);
            if (!tool) {
                if (up.client && up.info?.tools.some(t => t.name === name)) {
                    try {
                        return ok((await up.client.request('tools/call', msg.params ?? {})) as object);
                    } catch (err) {
                        return rpcError(msg.id, (err as { code?: number }).code ?? -32603, (err as Error).message);
                    }
                }
                return rpcError(msg.id, -32602, `Unknown tool: ${String(name)}`);
            }
            const raw = msg.params?.arguments ?? {};
            if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return rpcError(msg.id, -32602, 'arguments must be an object');
            const args = raw as ToolArgs;
            for (const key of tool.inputSchema.required ?? []) {
                if (args[key] === undefined || args[key] === '') return ok(fail(`Missing required argument "${key}"`));
            }
            try {
                return ok((await tool.run(args, origin)) as object);
            } catch (err) {
                return ok(fail(`storyhub error: ${err instanceof Error ? err.message : String(err)}`));
            }
        }
        default:
            if (up.client && up.info && FORWARDED.has(msg.method)) {
                try {
                    return ok((await up.client.request(msg.method, msg.params ?? {})) as object);
                } catch (err) {
                    return rpcError(msg.id, (err as { code?: number }).code ?? -32603, (err as Error).message);
                }
            }
            return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY) {
                reject(new Error('body too large'));
                req.destroy();
            } else chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    if (body === undefined) {
        res.writeHead(status, headers).end();
        return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body));
};

/** Streamable HTTP endpoint handler (stateless, JSON responses only). */
export function createMcpHandler(deps: McpDeps) {
    return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const originHeader = req.headers.origin;
        if (originHeader) {
            let allowed = false;
            try {
                const host = new URL(originHeader).hostname;
                allowed = LOCAL_HOSTS.has(host) || host === (req.headers.host ?? '').split(':')[0];
            } catch {
                allowed = false;
            }
            if (!allowed) return send(res, 403, rpcError(null, -32000, 'Invalid origin'));
        }
        if (req.method !== 'POST') return send(res, 405, rpcError(null, -32000, 'Method not allowed; this server is stateless and only accepts POST'), { Allow: 'POST' });
        if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
            return send(res, 415, rpcError(null, -32000, 'Content-Type must be application/json'));
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(await readBody(req));
        } catch {
            return send(res, 400, rpcError(null, -32700, 'Parse error'));
        }
        const origin = deps.origin(req);
        const upstreamUrl = deps.upstreamUrl?.(req) ?? null;
        const upstream = upstreamUrl ? upstreamFor(upstreamUrl, deps.version) : null;
        const batch = Array.isArray(parsed);
        const messages = (batch ? parsed : [parsed]) as JsonRpcMessage[];
        const replies = (await Promise.all(messages.map(m => handleMessage(deps, m ?? {}, origin, upstream)))).filter(Boolean);
        if (!replies.length) return send(res, 202);
        return send(res, 200, batch ? replies : replies[0]);
    };
}
