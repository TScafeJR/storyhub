import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isBareSpec, isNodeModules, realpath, relInside } from './paths.js';
import { resolveFromWorktree } from './resolve.js';
import { getParser, loadParser } from './parser.js';
import type { FileChange, ResolveFn } from './types.js';

/** rel → set of rels it imports (both git-root relative). */
export type Edges = Map<string, Set<string>>;

const SCRIPT_RE = /\.(m|c)?[jt]sx?$/;
const SFC_RE = /\.(vue|svelte|astro)$/;
const MDX_RE = /\.mdx?$/;

/** Extracts runtime import specifiers from a source file. Type-only imports are skipped. */
export function extractSpecs(filename: string, code: string): string[] {
    if (MDX_RE.test(filename)) {
        const specs: string[] = [];
        for (const m of code.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm)) specs.push(m[1]);
        for (const m of code.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) specs.push(m[1]);
        return specs;
    }
    let source = code;
    let parseName = filename;
    if (SFC_RE.test(filename)) {
        source = [...code.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
        parseName = 'sfc.tsx';
    } else if (!SCRIPT_RE.test(filename)) {
        return [];
    }
    const parseSync = getParser();
    if (!parseSync) return regexSpecs(source);
    const { module, errors } = parseSync(parseName, source);
    if (errors.length && !module.hasModuleSyntax && !module.dynamicImports.length) return [];
    const specs: string[] = [];
    for (const imp of module.staticImports) {
        if (imp.entries.length && imp.entries.every(e => e.isType)) continue;
        specs.push(imp.moduleRequest.value);
    }
    for (const exp of module.staticExports) {
        for (const e of exp.entries) if (e.moduleRequest && !e.isType) specs.push(e.moduleRequest.value);
    }
    for (const dyn of module.dynamicImports) {
        const raw = source.slice(dyn.moduleRequest.start, dyn.moduleRequest.end).trim();
        const m = /^(['"`])([^'"`$]+)\1$/.exec(raw);
        if (m) specs.push(m[2]);
    }
    return [...new Set(specs)];
}

/**
 * Fallback scanner used only when no parser is available. It over-reports (comments and strings
 * can match), which can only make more files dirty: slower sharing, never a wrong render.
 */
export function regexSpecs(code: string): string[] {
    const specs = new Set<string>();
    const re = /\b(?:import|export)\s+(?!type\s)[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const m of code.matchAll(re)) specs.add(m[1] ?? m[2] ?? m[3]);
    return [...specs];
}

interface ParsedFile {
    mtimeMs: number;
    size: number;
    specs: string[];
}

/** Parses files on demand, caching by mtime + size so repeated graph walks are cheap. */
export class SpecCache {
    private cache = new Map<string, ParsedFile>();

    async specs(abs: string): Promise<string[] | null> {
        let st;
        try {
            st = await stat(abs);
        } catch {
            return null;
        }
        const hit = this.cache.get(abs);
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.specs;
        await loadParser();
        let specs: string[] = [];
        try {
            specs = extractSpecs(abs, await readFile(abs, 'utf8'));
        } catch {
            specs = [];
        }
        this.cache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, specs });
        return specs;
    }

    invalidate(abs?: string): void {
        if (abs) this.cache.delete(abs);
        else this.cache.clear();
    }
}

/** Caches resolutions per (importer directory, specifier, issuer directory). */
export class ResolveCache {
    private cache = new Map<string, Promise<string | null>>();
    constructor(private resolveFn: ResolveFn) {}

    resolve(spec: string, importer: string, issuer?: string): Promise<string | null> {
        const key = `${dirname(importer)}\0${spec}\0${issuer ? dirname(issuer) : ''}`;
        let hit = this.cache.get(key);
        if (!hit) {
            hit = this.resolveFn(spec, importer, issuer)
                .then(r => (r ? realpath(r) : null))
                .catch(() => null);
            this.cache.set(key, hit);
        }
        return hit;
    }

    clear(): void {
        this.cache.clear();
    }
}

export interface GraphContext {
    hubRoot: string;
    specs: SpecCache;
    resolver: ResolveCache;
}

/** Edges of one hub file (hub semantics). */
async function hubEdgesOf(ctx: GraphContext, rel: string): Promise<Set<string>> {
    const abs = join(ctx.hubRoot, rel);
    const out = new Set<string>();
    const specs = (await ctx.specs.specs(abs)) ?? [];
    await Promise.all(
        specs.map(async spec => {
            const r = await ctx.resolver.resolve(spec, abs);
            if (!r || isNodeModules(r)) return;
            const target = relInside(ctx.hubRoot, r);
            if (target && target !== rel) out.add(target);
        })
    );
    return out;
}

/** Walks the hub's import graph from the given entry files (git-root relative). */
export async function buildHubGraph(ctx: GraphContext, entries: string[], into: Edges = new Map()): Promise<Edges> {
    const queue = [...entries];
    const seen = new Set<string>();
    while (queue.length) {
        const batch = queue.splice(0, 64).filter(rel => !seen.has(rel));
        batch.forEach(rel => seen.add(rel));
        const results = await Promise.all(batch.map(async rel => [rel, await hubEdgesOf(ctx, rel)] as const));
        for (const [rel, edges] of results) {
            into.set(rel, edges);
            for (const t of edges) if (!seen.has(t)) queue.push(t);
        }
    }
    return into;
}

export interface BranchGraph {
    edges: Edges;
    missingDeps: string[];
}

/**
 * Builds a branch's graph copy-on-write over the hub graph: unchanged files reuse hub edges
 * (their content, and so their imports, are identical); changed files are parsed from the worktree.
 */
export async function buildBranchGraph(ctx: GraphContext, hubEdges: Edges, branchRoot: string, changes: FileChange[], entries: string[]): Promise<BranchGraph> {
    const changed = new Map(changes.map(c => [c.rel, c.kind]));
    const edges: Edges = new Map();
    const missing = new Set<string>();

    const edgesOf = async (rel: string): Promise<Set<string>> => {
        const kind = changed.get(rel);
        if (kind === 'D') return new Set();
        if (!kind) {
            let e = hubEdges.get(rel);
            if (!e) {
                e = await hubEdgesOf(ctx, rel);
                hubEdges.set(rel, e);
            }
            return e;
        }
        const abs = join(branchRoot, rel);
        const out = new Set<string>();
        for (const spec of (await ctx.specs.specs(abs)) ?? []) {
            const r = await resolveFromWorktree((s, imp, issuer) => ctx.resolver.resolve(s, imp, issuer), p => p, spec, abs, ctx.hubRoot, branchRoot);
            if (!r) {
                if (isBareSpec(spec)) missing.add(spec);
                continue;
            }
            if (isNodeModules(r)) continue;
            const target = relInside(ctx.hubRoot, r) ?? relInside(branchRoot, r);
            if (target && target !== rel) out.add(target);
        }
        return out;
    };

    const queue = [...entries];
    const seen = new Set<string>();
    while (queue.length) {
        const batch = queue.splice(0, 64).filter(rel => !seen.has(rel));
        batch.forEach(rel => seen.add(rel));
        const results = await Promise.all(batch.map(async rel => [rel, await edgesOf(rel)] as const));
        for (const [rel, e] of results) {
            edges.set(rel, e);
            for (const t of e) if (!seen.has(t)) queue.push(t);
        }
    }
    return { edges, missingDeps: [...missing].sort() };
}

/** Seeds plus every node that can reach a seed (reverse reachability). */
export function reverseClosure(edges: Edges, seeds: Iterable<string>): Set<string> {
    const reverse = new Map<string, string[]>();
    for (const [from, tos] of edges) {
        for (const to of tos) {
            let list = reverse.get(to);
            if (!list) reverse.set(to, (list = []));
            list.push(from);
        }
    }
    const out = new Set<string>(seeds);
    const queue = [...out];
    while (queue.length) {
        const cur = queue.pop()!;
        for (const from of reverse.get(cur) ?? []) {
            if (!out.has(from)) {
                out.add(from);
                queue.push(from);
            }
        }
    }
    return out;
}

/** Shortest import chain from `start` to any file in `targets` (inclusive), or null. */
export function importChain(edges: Edges, start: string, targets: Set<string>): string[] | null {
    if (targets.has(start)) return [start];
    const prev = new Map<string, string>();
    const queue = [start];
    const seen = new Set([start]);
    while (queue.length) {
        const cur = queue.shift()!;
        for (const next of edges.get(cur) ?? []) {
            if (seen.has(next)) continue;
            seen.add(next);
            prev.set(next, cur);
            if (targets.has(next)) {
                const chain = [next];
                let p = cur;
                while (p !== undefined) {
                    chain.unshift(p);
                    p = prev.get(p)!;
                }
                return chain;
            }
            queue.push(next);
        }
    }
    return null;
}
