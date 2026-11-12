/**
 * A small MCP client for `@storybook/addon-mcp` running on the same dev server, so storyhub can be
 * the only MCP server an agent needs: its tools, resources and prompts are passed through, and
 * storyhub adds branch awareness on top. Nothing here is required: without addon-mcp, storyhub's
 * own tools still work.
 */
export interface UpstreamTool {
    name: string;
    title?: string;
    description?: string;
    inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown };
    outputSchema?: unknown;
    _meta?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface UpstreamInfo {
    instructions?: string;
    capabilities: Record<string, unknown>;
    tools: UpstreamTool[];
}

const PROTOCOL_VERSION = '2025-06-18';
const NEGATIVE_CACHE_MS = 15_000;

/** Reads a JSON-RPC response from either a JSON body or a server-sent event stream. */
function parseBody(text: string, contentType: string | null, id: number): Record<string, unknown> | null {
    if (contentType?.includes('text/event-stream')) {
        for (const block of text.split(/\n\n+/)) {
            const data = block
                .split('\n')
                .filter(l => l.startsWith('data:'))
                .map(l => l.slice(5).trim())
                .join('');
            if (!data) continue;
            try {
                const msg = JSON.parse(data) as Record<string, unknown>;
                if (msg.id === id) return msg;
            } catch {
                // not JSON: ignore
            }
        }
        return null;
    }
    return text ? (JSON.parse(text) as Record<string, unknown>) : null;
}

export class UpstreamMcp {
    private session: string | undefined;
    private info: Promise<UpstreamInfo | null> | undefined;
    private missingSince = 0;
    private nextId = 1;

    constructor(
        private url: string,
        private clientVersion: string
    ) {}

    private async post(body: Record<string, unknown>, timeoutMs: number): Promise<Response> {
        return fetch(this.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                'MCP-Protocol-Version': PROTOCOL_VERSION,
                ...(this.session ? { 'Mcp-Session-Id': this.session } : {})
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs)
        });
    }

    /** One JSON-RPC call over HTTP; returns `result`, throws on errors. No connection handling. */
    private async call(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<{ result?: unknown; status: number }> {
        const id = this.nextId++;
        const res = await this.post({ jsonrpc: '2.0', id, method, params }, timeoutMs);
        this.session = res.headers.get('mcp-session-id') ?? this.session;
        const msg = parseBody(await res.text(), res.headers.get('content-type'), id);
        if (!msg) {
            if (!res.ok) return { status: res.status };
            throw new Error('addon-mcp sent no response');
        }
        if (msg.error) {
            const err = msg.error as { code?: number; message?: string };
            throw Object.assign(new Error(err.message ?? 'addon-mcp error'), { code: err.code });
        }
        return { result: msg.result, status: res.status };
    }

    /** Sends a request on a connected session and returns its `result`. */
    async request(method: string, params: Record<string, unknown> = {}, timeoutMs = 600_000): Promise<unknown> {
        if (!(await this.connect())) throw new Error('@storybook/addon-mcp is not available');
        let r = await this.call(method, params, timeoutMs);
        if (r.status === 404 || r.status === 400) {
            // session expired (e.g. Storybook restarted): reconnect once
            this.reset();
            if (!(await this.connect())) throw new Error('@storybook/addon-mcp is not available');
            r = await this.call(method, params, timeoutMs);
        }
        if (r.status >= 400) throw new Error(`addon-mcp answered ${r.status}`);
        return r.result;
    }

    private reset(): void {
        this.session = undefined;
        this.info = undefined;
    }

    /** Connects (once) and lists the upstream tools; null when addon-mcp is not there. */
    connect(): Promise<UpstreamInfo | null> {
        if (!this.info && Date.now() - this.missingSince < NEGATIVE_CACHE_MS) return Promise.resolve(null);
        this.info ??= (async () => {
            try {
                const initialized = await this.call('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'storyhub', version: this.clientVersion } }, 10_000);
                if (initialized.status >= 400) throw new Error(`addon-mcp answered ${initialized.status}`);
                const init = initialized.result as { instructions?: string; capabilities?: Record<string, unknown> };
                await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, 10_000).catch(() => undefined);
                const listed = (await this.call('tools/list', {}, 10_000)).result as { tools?: UpstreamTool[] };
                return { instructions: init.instructions, capabilities: init.capabilities ?? {}, tools: listed.tools ?? [] };
            } catch {
                this.missingSince = Date.now();
                this.info = undefined;
                return null;
            }
        })();
        return this.info;
    }
}

const clients = new Map<string, UpstreamMcp>();

export function upstreamFor(url: string, version: string): UpstreamMcp {
    let client = clients.get(url);
    if (!client) clients.set(url, (client = new UpstreamMcp(url, version)));
    return client;
}
