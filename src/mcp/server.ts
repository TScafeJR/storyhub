import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { StoryHub } from '../core/state.js';
import type { StoryIndex } from '../server/branchIndex.js';

export interface McpDeps {
    getHub: () => Promise<StoryHub>;
    getHubIndex: () => Promise<StoryIndex>;
    getBranchIndex: (branchId: string) => Promise<StoryIndex | null>;
    /** Absolute origin agents should open URLs on, e.g. http://localhost:6006 */
    origin: (req: IncomingMessage) => string;
    version: string;
}

const DRIFT_HELP = {
    'deps-drift': 'package.json or a lockfile changed; the branch still renders with the hub dependencies',
    'config-drift': 'the Storybook config dir changed; the hub preview and decorators are used',
    diverged: 'some files changed on both the hub and the branch since they split; the branch version wins',
    'missing-dep': 'the branch imports packages the hub cannot resolve; affected stories will error'
};

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

function buildServer(deps: McpDeps, origin: string): McpServer {
    const server = new McpServer(
        { name: 'storyhub', version: deps.version },
        {
            instructions:
                'storyhub renders every git worktree of this repo as a branch section in one Storybook. ' +
                'Branch sections only contain stories whose rendering that branch changes. Use list-branches first, ' +
                'get-branch-changes to see what a branch touched and why each story is affected, and get-story-variants ' +
                'to get side-by-side URLs (hub vs branches) for a story id.'
        }
    );

    const managerUrl = (refId: string | null, storyId: string) => `${origin}/?path=/story/${refId ? `${refId}_` : ''}${storyId}`;
    const iframeUrl = (base: string, storyId: string) => `${origin}${base}/iframe.html?id=${encodeURIComponent(storyId)}&viewMode=story`;

    server.registerTool(
        'list-branches',
        {
            title: 'List worktree branches',
            description: 'Lists every git worktree rendered as a branch section, with drift flags and how many files and stories each one changes.',
            inputSchema: {}
        },
        async () => {
            const hub = await deps.getHub();
            const branches = hub.summaries().map(s => ({ ...s, refUrl: `${origin}${s.refUrl}`, driftHelp: s.drift.map(d => DRIFT_HELP[d]) }));
            return json({ hubRoot: hub.root, hubStoryFiles: hub.hubStories.length, branches });
        }
    );

    server.registerTool(
        'get-branch-changes',
        {
            title: 'Get a branch’s changes and affected stories',
            description:
                'For one branch (worktree id from list-branches): changed files since its merge base with the hub, drift flags, and every affected story with the import chain that explains why it is affected, plus URLs to view it.',
            inputSchema: { branch: z.string().describe('Branch/worktree id from list-branches') }
        },
        async ({ branch }) => {
            const hub = await deps.getHub();
            const b = hub.branches.get(branch);
            if (!b) return fail(`Unknown branch "${branch}". Known: ${[...hub.branches.keys()].join(', ') || '(none)'}`);
            const index = await deps.getBranchIndex(branch);
            const base = `${hub.refBase}/${branch}`;
            const stories = b.affectedStories.map(file => {
                const ids = Object.values(index?.entries ?? {})
                    .filter(e => e.type === 'story' && e.importPath.endsWith(`/${file}`))
                    .map(e => ({ id: e.id, title: e.title, name: e.name, managerUrl: managerUrl(branch, e.id), iframeUrl: iframeUrl(base, e.id) }));
                return { file, reason: hub.reason(branch, file), stories: ids };
            });
            return json({
                branch,
                path: b.worktree.path,
                mergeBase: b.mergeBase,
                drift: b.drift.map(d => ({ flag: d, meaning: DRIFT_HELP[d] })),
                diverged: b.diverged,
                missingDeps: b.missingDeps,
                changes: b.changes,
                affected: stories,
                ...(b.error ? { error: b.error } : {})
            });
        }
    );

    server.registerTool(
        'get-story-variants',
        {
            title: 'Get every rendering of a story',
            description:
                'Given a story id (e.g. "components-button--primary"), returns its URL in the hub plus the URL in every branch whose changes affect it, for side-by-side comparison or screenshots.',
            inputSchema: { storyId: z.string().describe('Story id as used in the hub, without any ref prefix') }
        },
        async ({ storyId }) => {
            const hub = await deps.getHub();
            const hubIndex = await deps.getHubIndex();
            const hubEntry = hubIndex.entries[storyId];
            const variants = [];
            for (const b of hub.branches.values()) {
                const index = await deps.getBranchIndex(b.worktree.id);
                const entry = index?.entries[storyId];
                if (!entry) continue;
                const file = b.affectedStories.find(f => entry.importPath.endsWith(`/${f}`));
                variants.push({
                    branch: b.worktree.id,
                    drift: b.drift,
                    reason: file ? hub.reason(b.worktree.id, file) : null,
                    managerUrl: managerUrl(b.worktree.id, storyId),
                    iframeUrl: iframeUrl(`${hub.refBase}/${b.worktree.id}`, storyId)
                });
            }
            if (!hubEntry && !variants.length) return fail(`Story "${storyId}" is not in the hub or any branch.`);
            return json({
                storyId,
                hub: hubEntry ? { title: hubEntry.title, name: hubEntry.name, managerUrl: managerUrl(null, storyId), iframeUrl: iframeUrl('', storyId) } : null,
                variants
            });
        }
    );

    return server;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Stateless Streamable HTTP MCP endpoint handler. */
export function createMcpHandler(deps: McpDeps) {
    return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const originHeader = req.headers.origin;
        if (originHeader) {
            let ok = false;
            try {
                const host = new URL(originHeader).hostname;
                ok = LOCAL_HOSTS.has(host) || host === (req.headers.host ?? '').split(':')[0];
            } catch {
                ok = false;
            }
            if (!ok) {
                res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Invalid origin');
                return;
            }
        }
        const server = buildServer(deps, deps.origin(req));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => {
            void transport.close();
            void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
    };
}
