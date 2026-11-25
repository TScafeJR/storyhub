import { describe, expect, it } from 'vitest';
import { handleMessage, type McpDeps } from '../../src/mcp/server.js';

const deps = { getHub: async () => ({ allWorktrees: [] }), version: 'test' } as unknown as McpDeps;
const request = async (method: string, params = {}) => ((await handleMessage(deps, { jsonrpc: '2.0', id: 1, method, params }, 'http://localhost:6006')) as { result: Record<string, unknown> }).result;

const expectCleanUp = (text: string) => {
    expect(text).toContain('When a branch you worked on merges');
    // the base is the remote's branch, so a stale ref would hide the merge
    expect(text.indexOf('git fetch')).toBeLessThan(text.indexOf('storyhub clean`'));
    expect(text).toContain('storyhub clean --yes');
    expect(text).toContain('no commits yet'); // --yes can take another agent's new worktree
};

describe('agent guidance', () => {
    it('tells agents to clean up after a merge, in the instructions and list-worktrees', async () => {
        expectCleanUp((await request('initialize')).instructions as string);
        const { tools } = (await request('tools/list')) as { tools: Array<{ name: string; description: string }> };
        expectCleanUp(tools.find(t => t.name === 'list-worktrees')!.description);
        const { content } = (await request('tools/call', { name: 'list-worktrees' })) as { content: Array<{ text: string }> };
        expect(JSON.parse(content[0].text).howTo.afterMerge).toContain('storyhub clean');
    });
});
