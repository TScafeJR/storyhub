import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StoryHub } from '../core/state.js';
import type { StoryIndex } from '../server/branchIndex.js';

/**
 * A minimal, dependency-free MCP server over Streamable HTTP in stateless JSON-response mode:
 * every POST carries JSON-RPC messages and gets a JSON reply; there are no sessions or SSE streams.
 * That is all three read-only tools need, and it keeps storyhub's install surface at zero packages.
 */

export interface McpDeps {
    getHub: () => Promise<StoryHub>;
    getHubIndex: () => Promise<StoryIndex>;
    getBranchIndex: (branchId: string) => Promise<StoryIndex | null>;
    /** Absolute origin agents should open URLs on, e.g. http://localhost:6006 */
    origin: (req: IncomingMessage) => string;
    version: string;
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
    'to get side-by-side URLs (hub vs branches) for a story id.';

interface ToolResult {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
}
interface Tool {
    name: string;
    title: string;
    description: string;
    inputSchema: { type: 'object'; properties: Record<string, { type: 'string'; description: string }>; required: string[]; additionalProperties: false };
    run: (args: Record<string, string>, origin: string) => Promise<ToolResult>;
}

const json = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

const managerUrl = (origin: string, refId: string | null, storyId: string) => `${origin}/?path=/story/${refId ? `${refId}_` : ''}${storyId}`;
const iframeUrl = (origin: string, base: string, storyId: string) => `${origin}${base}/iframe.html?id=${encodeURIComponent(storyId)}&viewMode=story`;

function tools(deps: McpDeps): Tool[] {
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
            run: async ({ branch }, origin) => {
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
            run: async ({ storyId }, origin) => {
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
        }
    ];
}

interface JsonRpcMessage {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
}

const rpcError = (id: JsonRpcMessage['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** Handles one JSON-RPC message; returns undefined for notifications. */
export async function handleMessage(deps: McpDeps, msg: JsonRpcMessage, origin: string): Promise<object | undefined> {
    const isRequest = msg.id !== undefined && msg.id !== null;
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return isRequest ? rpcError(msg.id, -32600, 'Invalid Request') : undefined;
    if (!isRequest) return undefined; // notifications (initialized, cancelled, ...) need no reply
    const ok = (result: object) => ({ jsonrpc: '2.0', id: msg.id, result });
    const toolList = tools(deps);

    switch (msg.method) {
        case 'initialize': {
            const requested = String(msg.params?.protocolVersion ?? '');
            return ok({
                protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'storyhub', version: deps.version },
                instructions: INSTRUCTIONS
            });
        }
        case 'ping':
            return ok({});
        case 'tools/list':
            return ok({ tools: toolList.map(({ run: _run, ...t }) => t) });
        case 'tools/call': {
            const name = msg.params?.name;
            const tool = toolList.find(t => t.name === name);
            if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${String(name)}`);
            const raw = msg.params?.arguments ?? {};
            if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return rpcError(msg.id, -32602, 'arguments must be an object');
            const args = raw as Record<string, unknown>;
            for (const key of tool.inputSchema.required) {
                if (typeof args[key] !== 'string' || !args[key]) return ok(fail(`Missing required string argument "${key}"`));
            }
            try {
                return ok(await tool.run(args as Record<string, string>, origin));
            } catch (err) {
                return ok(fail(`storyhub error: ${err instanceof Error ? err.message : String(err)}`));
            }
        }
        default:
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
        const batch = Array.isArray(parsed);
        const messages = (batch ? parsed : [parsed]) as JsonRpcMessage[];
        const replies = (await Promise.all(messages.map(m => handleMessage(deps, m ?? {}, origin)))).filter(Boolean);
        if (!replies.length) return send(res, 202);
        return send(res, 200, batch ? replies : replies[0]);
    };
}
