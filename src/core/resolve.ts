import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isNodeModules, isRelativeSpec, relInside } from './paths.js';

const splitQuery = (id: string): [string, string] => {
    const q = id.search(/[?#]/);
    return q === -1 ? [id, ''] : [id.slice(0, q), id.slice(q)];
};

/**
 * Resolves an import made by a file inside a worktree.
 *
 * The import first resolves from the file's hub twin, so aliases, tsconfig paths and packages
 * behave exactly as in the hub. A target that exists only in the branch has no hub file, though:
 * a relative import finds nothing, and an alias into the hub (`@/x` → `<hub>/src/x`) yields a hub
 * path that does not exist (or nothing at all). Those cases retry against the worktree: first the
 * same hub-relative path inside the worktree, then (relative imports only) from the worktree file
 * itself. Bare packages never fall back, so dependencies keep coming from the hub.
 *
 * The first resolution also passes the worktree file as `issuer`, for resolvers (webpack's) that
 * do the worktree fallback inside their own pipeline.
 *
 * Generic over the resolver's result so both builder pipelines (Vite's ResolvedId, plain paths)
 * share it; `idOf` reads the resolved id (it may carry a query).
 */
export async function resolveFromWorktree<T>(
    resolve: (spec: string, importer: string, issuer?: string) => Promise<T | null>,
    idOf: (r: T) => string,
    spec: string,
    importer: string,
    hubRoot: string,
    wtRoot: string
): Promise<T | null> {
    const rel = relInside(wtRoot, importer);
    if (rel === null) return resolve(spec, importer);
    const fromHub = await resolve(spec, join(hubRoot, rel), importer);
    let hubPath: string | null = null;
    let query = '';
    if (fromHub) {
        [hubPath, query] = splitQuery(idOf(fromHub));
        // virtual modules, externals and files that exist are final
        if (hubPath.startsWith('\0') || !isAbsolute(hubPath) || existsSync(hubPath)) return fromHub;
    } else if (isAbsolute(spec)) {
        // the builder may apply aliases before other plugins see the import (Vite does), so the
        // spec can already be the rewritten hub path
        [hubPath, query] = splitQuery(spec);
    }
    if (hubPath && !isNodeModules(hubPath) && relInside(wtRoot, hubPath) === null) {
        const target = relInside(hubRoot, hubPath);
        if (target !== null) {
            const mapped = await resolve(join(wtRoot, target) + query, importer);
            if (mapped && existsSync(splitQuery(idOf(mapped))[0])) return mapped;
        }
    }
    if (isRelativeSpec(spec)) {
        const local = await resolve(spec, importer);
        if (local) return local;
    }
    return fromHub;
}
