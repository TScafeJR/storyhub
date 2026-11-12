import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { storyNameFromExport, toId } from 'storybook/internal/csf';
import { loadCsf } from 'storybook/internal/csf-tools';
import { userOrAutoTitleFromSpecifier } from 'storybook/internal/preview-api';
import type { InternalBranch } from '../core/state.js';
import { relInside, toPosix } from '../core/paths.js';
import { IMPORT_PREFIX } from '../codegen.js';

export interface IndexEntry {
    type: 'story' | 'docs';
    id: string;
    name: string;
    title: string;
    importPath: string;
    tags?: string[];
    storiesImports?: string[];
    [key: string]: unknown;
}

export interface StoryIndex {
    v: number;
    entries: Record<string, IndexEntry>;
}

export interface Specifier {
    titlePrefix?: string;
    directory: string;
    files: string;
    importPathMatcher: RegExp;
}

export interface IndexContext {
    gitRoot: string;
    /** Directory Storybook's importPaths are relative to (process.cwd() of the dev server). */
    workingDir: string;
    specifiers: Specifier[];
}

/** './src/x.stories.tsx' style path Storybook uses for a git-root-relative file. */
export function toImportPath(ctx: IndexContext, rel: string): string {
    const p = toPosix(relative(ctx.workingDir, join(ctx.gitRoot, rel)));
    return p.startsWith('../') ? p : `./${p}`;
}

export function isStoryFileFor(ctx: IndexContext): (rel: string) => boolean {
    return rel => {
        const importPath = toImportPath(ctx, rel);
        return ctx.specifiers.some(s => s.importPathMatcher.test(importPath));
    };
}

const branchImportPath = (branch: InternalBranch, rel: string) => IMPORT_PREFIX + join(branch.worktree.path, rel);

/** Indexes a story file from the worktree (used for new or edited CSF files). */
async function indexStoryFile(ctx: IndexContext, branch: InternalBranch, rel: string): Promise<IndexEntry[]> {
    const abs = join(branch.worktree.path, rel);
    const importPath = toImportPath(ctx, rel);
    const specifier = ctx.specifiers.find(s => s.importPathMatcher.test(importPath));
    const code = await readFile(abs, 'utf8');
    const csf = loadCsf(code, {
        fileName: importPath,
        makeTitle: (userTitle?: string) => (specifier ? userOrAutoTitleFromSpecifier(importPath, specifier as never, userTitle) : userTitle) ?? rel
    }).parse();
    const out: IndexEntry[] = [];
    const target = branchImportPath(branch, rel);
    let title = '';
    const metaTags: string[] = ((csf as unknown as { meta?: { tags?: string[] } }).meta?.tags ?? []).slice();
    for (const input of csf.indexInputs) {
        const name = input.name ?? storyNameFromExport(input.exportName);
        const entryTitle = input.title ?? rel;
        const id = input.__id ?? toId(input.metaId ?? entryTitle, name);
        title = entryTitle;
        out.push({
            ...(input.type === 'story' && input.parent ? { parent: input.parent, parentName: input.parentName } : {}),
            type: 'story',
            subtype: input.type === 'story' ? (input.subtype ?? 'story') : 'story',
            id,
            name,
            title: entryTitle,
            importPath: target,
            exportName: input.exportName,
            tags: [...new Set(['dev', 'test', ...(input.tags ?? [])])]
        });
    }
    if (title && metaTags.includes('autodocs')) {
        out.unshift({ type: 'docs', id: toId(title, 'docs'), name: 'Docs', title, importPath: target, storiesImports: [], tags: ['dev', 'test', 'autodocs', ...metaTags] });
    }
    return out;
}

/**
 * The story index served for a branch ref: only stories this branch's diff affects. Unchanged story
 * files reuse the hub's entries (same ids and titles) pointed at the worktree copy; new or edited
 * CSF files are re-indexed from the worktree.
 */
export async function buildBranchIndex(ctx: IndexContext, branch: InternalBranch, hubIndex: StoryIndex): Promise<StoryIndex> {
    const affected = new Set(branch.affectedStories);
    const kinds = new Map(branch.changes.map(c => [c.rel, c.kind]));
    const entries: Record<string, IndexEntry> = {};
    const reindex = new Set([...affected].filter(rel => kinds.get(rel) === 'A' || kinds.get(rel) === 'M'));

    const relOf = (importPath: string) => (importPath.startsWith('virtual:') ? null : relInside(ctx.gitRoot, resolve(ctx.workingDir, importPath)));
    const mapImport = (importPath: string) => {
        const rel = relOf(importPath);
        return rel && affected.has(rel) ? branchImportPath(branch, rel) : importPath;
    };

    for (const entry of Object.values(hubIndex.entries)) {
        const rel = relOf(entry.importPath);
        if (!rel || !affected.has(rel)) continue;
        if (reindex.has(rel) && entry.type === 'story') continue;
        entries[entry.id] = {
            ...entry,
            importPath: branchImportPath(branch, rel),
            ...(entry.storiesImports ? { storiesImports: entry.storiesImports.map(mapImport) } : {})
        };
    }
    for (const rel of reindex) {
        try {
            for (const e of await indexStoryFile(ctx, branch, rel)) if (!entries[e.id] || e.type === 'story') entries[e.id] = e;
        } catch (err) {
            // an unparsable story file still deserves a visible entry rather than silently vanishing
            const id = toId(`storyhub-errors/${rel}`, 'error');
            entries[id] = { type: 'story', subtype: 'story', id, name: `Index error: ${(err as Error).message.split('\n')[0]}`, title: `storyhub errors/${rel}`, importPath: branchImportPath(branch, rel), tags: ['dev'] };
        }
    }
    return { v: hubIndex.v ?? 5, entries };
}
