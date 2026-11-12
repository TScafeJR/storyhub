import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { IMPORT_PREFIX } from '../codegen.js';
import { realpath, relInside } from '../core/paths.js';
import type { StoryHub } from '../core/state.js';
import type { IndexEntry, StoryIndex } from '../server/branchIndex.js';
import { runStories, type StoryRun } from './browser.js';

/** The story input shape addon-mcp uses, so agents can call either server the same way. */
export interface StoryInput {
    storyId?: string;
    absoluteStoryPath?: string;
    exportName?: string;
    props?: Record<string, unknown>;
    globals?: Record<string, unknown>;
}

export interface StoryContext {
    hub: StoryHub;
    hubIndex: StoryIndex;
    branchIndex: (id: string) => Promise<StoryIndex | null>;
    origin: string;
    refBase: string;
}

export interface ResolvedStory {
    input: StoryInput;
    /** Branch id, or null for the hub (Common). */
    branch: string | null;
    storyId: string;
    entry: IndexEntry;
}

export interface Unresolved {
    input: StoryInput;
    error: string;
}

/** One value in Storybook's URL args format. */
const encodeArg = (v: unknown): string => {
    if (v === undefined) return '!undefined';
    if (v === null) return '!null';
    if (typeof v === 'boolean') return `!${v}`;
    if (v instanceof Date) return `!date(${v.toISOString()})`;
    if (typeof v === 'string' && /^#([a-f0-9]{3,4}|[a-f0-9]{6}|[a-f0-9]{8})$/i.test(v)) return `!hex(${v.slice(1)})`;
    return encodeURIComponent(String(v)).replace(/%20/g, '+').replace(/%2C/gi, ',').replace(/%3A/gi, ':');
};

/** Storybook's URL args format: key:value pairs joined by ';' with !-prefixed specials. */
export function buildArgsParam(args: Record<string, unknown> | undefined): string {
    if (!args) return '';
    const parts: string[] = [];
    const walk = (prefix: string, value: unknown) => {
        if (value && typeof value === 'object' && !(value instanceof Date)) {
            for (const [k, v] of Object.entries(value)) walk(Array.isArray(value) ? `${prefix}[${k}]` : prefix ? `${prefix}.${k}` : k, v);
        } else parts.push(`${prefix}:${encodeArg(value)}`);
    };
    walk('', args);
    return parts.join(';');
}

/** Preview URL in addon-mcp's format; branch ones go through /__storyhub/<id>/ (see the preset). */
export function previewUrl(ctx: StoryContext, branch: string | null, storyId: string, input: StoryInput): string {
    let url = `${ctx.origin}${branch ? `${ctx.refBase}/${branch}/` : '/'}?path=/story/${storyId}`;
    const args = buildArgsParam(input.props);
    if (args) url += `&args=${args}`;
    const globals = buildArgsParam(input.globals);
    if (globals) url += `&globals=${globals}`;
    return url;
}

export function iframeUrl(ctx: StoryContext, branch: string | null, storyId: string, extra = ''): string {
    return `${ctx.origin}${branch ? `${ctx.refBase}/${branch}` : ''}/iframe.html?id=${encodeURIComponent(storyId)}&viewMode=story${extra}`;
}

/** The branch a story path belongs to, from its location on disk; null for the hub. */
function branchOfPath(ctx: StoryContext, abs: string): { branch: string | null } | { error: string } {
    const p = existsSync(abs) ? realpath(abs) : abs;
    const shown = ctx.hub.branchForPath(p);
    if (shown) return { branch: shown.worktree.id };
    const hidden = ctx.hub.allWorktrees.find(w => !w.isHub && relInside(w.path, p) !== null);
    if (hidden) return { error: `${abs} is in worktree ${hidden.branch ?? hidden.path}, which is not shown in Storybook. Turn it on first: run \`npx --no-install storyhub on\` inside it.` };
    return { branch: null };
}

const entryPath = (entry: IndexEntry): string => (entry.importPath.startsWith(IMPORT_PREFIX) ? entry.importPath.slice(IMPORT_PREFIX.length) : resolve(process.cwd(), entry.importPath));

/** Resolves addon-mcp style story inputs against the hub or a branch. */
export async function resolveStories(ctx: StoryContext, inputs: StoryInput[], explicitBranch?: string): Promise<Array<ResolvedStory | Unresolved>> {
    if (explicitBranch && !ctx.hub.branches.has(explicitBranch)) {
        const known = [...ctx.hub.branches.keys()];
        return inputs.map(input => ({ input, error: `Unknown or hidden branch "${explicitBranch}". Shown branches: ${known.join(', ') || '(none; turn one on with `npx --no-install storyhub on`)'}` }));
    }
    const out: Array<ResolvedStory | Unresolved> = [];
    for (const input of inputs) {
        let branch: string | null = explicitBranch ?? null;
        if (!explicitBranch && input.absoluteStoryPath) {
            const found = branchOfPath(ctx, input.absoluteStoryPath);
            if ('error' in found) {
                out.push({ input, error: found.error });
                continue;
            }
            branch = found.branch;
        }
        const index = branch ? await ctx.branchIndex(branch) : ctx.hubIndex;
        if (!index) {
            out.push({ input, error: `Branch "${branch}" has no index yet.` });
            continue;
        }
        let entry: IndexEntry | undefined;
        if (input.storyId) {
            entry = index.entries[input.storyId];
        } else if (input.absoluteStoryPath && input.exportName) {
            // a worktree path names its file in the branch; the same relative file in the hub otherwise
            const rel = relInside(branch ? ctx.hub.branches.get(branch)!.worktree.path : ctx.hub.root, existsSync(input.absoluteStoryPath) ? realpath(input.absoluteStoryPath) : input.absoluteStoryPath);
            entry = Object.values(index.entries).find(e => e.type === 'story' && e.exportName === input.exportName && rel !== null && entryPath(e).endsWith(`/${rel}`));
        } else {
            out.push({ input, error: 'Each story needs a storyId, or an absoluteStoryPath with an exportName.' });
            continue;
        }
        if (!entry || entry.type !== 'story') {
            const what = input.storyId ?? `${input.exportName} in ${input.absoluteStoryPath}`;
            if (branch) {
                const inHub = input.storyId ? ctx.hubIndex.entries[input.storyId] : undefined;
                out.push({
                    input,
                    error: inHub
                        ? `${what} is not changed by branch ${branch}, so it renders the same as in Common: ${previewUrl(ctx, null, input.storyId!, input)}`
                        : `${what} is not in branch ${branch}. Use list-branches / get-branch-changes to see its stories.`
                });
            } else out.push({ input, error: `No story found for ${what}.` });
            continue;
        }
        out.push({ input, branch, storyId: entry.id, entry });
    }
    return out;
}

export interface TestOutcome extends StoryRun {
    branch: string | null;
    title?: string;
    name?: string;
    /** Result of the same story in Common, when compared. */
    common?: StoryRun;
    /** Fails in the branch but passes in Common. */
    regression?: boolean;
    /** Passes in the branch but fails in Common. */
    fixed?: boolean;
}

/** Runs stories in headless Chromium against their branch (and optionally Common) iframes. */
export async function testInBrowser(ctx: StoryContext, stories: ResolvedStory[], opts: { a11y: boolean; compare: boolean }): Promise<TestOutcome[]> {
    // a11y runs automatically after each render unless switched to manual for this run
    const extra = opts.a11y ? '' : '&globals=a11y.manual:!true';
    const targets = stories.map(s => ({ storyId: s.storyId, url: iframeUrl(ctx, s.branch, s.storyId, extra) }));
    const compared = opts.compare ? stories.filter(s => s.branch && ctx.hubIndex.entries[s.storyId]) : [];
    const [runs, commonRuns] = await Promise.all([runStories(targets), runStories(compared.map(s => ({ storyId: s.storyId, url: iframeUrl(ctx, null, s.storyId, extra) })))]);
    const common = new Map(compared.map((s, i) => [s.storyId, commonRuns[i]]));
    return stories.map((s, i) => {
        const run = runs[i];
        const c = s.branch ? common.get(s.storyId) : undefined;
        return {
            ...run,
            branch: s.branch,
            title: s.entry.title,
            name: s.entry.name,
            ...(c ? { common: c, regression: run.status !== 'passed' && c.status === 'passed', fixed: run.status === 'passed' && c.status !== 'passed' } : {})
        };
    });
}

export function formatOutcomes(outcomes: TestOutcome[]): string {
    const lines: string[] = [];
    const groups = new Map<string, TestOutcome[]>();
    for (const o of outcomes) {
        const key = o.branch ?? 'Common';
        groups.set(key, [...(groups.get(key) ?? []), o]);
    }
    for (const [group, list] of groups) {
        const passed = list.filter(o => o.status === 'passed').length;
        const regressions = list.filter(o => o.regression).length;
        lines.push(`## ${group === 'Common' ? 'Common' : `Branch ${group}`}: ${passed}/${list.length} passed${regressions ? `, ${regressions} regression(s) vs Common` : ''}`);
        for (const o of list) {
            const mark = o.status === 'passed' ? '✓' : '✗';
            const note = o.regression ? ' (regression: passes in Common)' : o.fixed ? ' (fixed: fails in Common)' : '';
            lines.push(`${mark} ${o.storyId} [${o.status}]${note}`);
            if (o.error) lines.push(`    ${o.error.split('\n').slice(0, 6).join('\n    ')}`);
            for (const v of o.a11y?.violations ?? []) lines.push(`    a11y ${v.impact ?? 'unknown'}: ${v.id} (${v.nodes} node(s)): ${v.help}`);
        }
    }
    return lines.join('\n');
}
