import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { StoryHub } from './core/state.js';

/** Branch story import paths are `storyhub:<absolute worktree path>`. */
export const IMPORT_PREFIX = 'storyhub:';

/** JS expression evaluating to the branch id of the current iframe (`/__storyhub/<id>/...`), or null. */
export const BRANCH_FROM_LOCATION = `(typeof location !== 'undefined' && (location.pathname.match(/\\/__storyhub\\/([^/]+)\\//) || [])[1]) || null`;

/**
 * Code appended to a builder's generated stories module (which exports `importFn`) so the preview
 * can import branch stories. Works for any bundler that understands static `import()` of an
 * absolute path (Vite, webpack).
 */
export function branchImportersCode(hub: StoryHub | undefined): string {
    const entries: string[] = [];
    for (const b of hub?.branches.values() ?? []) {
        for (const rel of b.affectedStories) {
            const abs = join(b.worktree.path, rel);
            // a missing path would fail the whole module, hub stories included
            if (!existsSync(abs)) continue;
            entries.push(`  ${JSON.stringify(IMPORT_PREFIX + abs)}: () => import(${JSON.stringify(abs)})`);
        }
    }
    return `
// --- storyhub: branch story importers ---
const __storyhubImporters = {
${entries.join(',\n')}
};
const __storyhubOriginalImportFn = importFn;
importFn = async function storyhubImportFn(path) {
  if (typeof path === 'string' && path.startsWith(${JSON.stringify(IMPORT_PREFIX)})) {
    const load = __storyhubImporters[path];
    if (load) return await load();
    throw new Error('storyhub: ' + path + ' is not built yet; reload in a moment');
  }
  return await __storyhubOriginalImportFn(path);
};
`;
}
