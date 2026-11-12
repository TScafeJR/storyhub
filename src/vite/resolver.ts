import type { ViteDevServer } from 'vite';
import { cleanId } from '../core/paths.js';
import type { ResolveFn } from '../core/types.js';

/** Marker passed through `custom` so storyhub's own redirect plugin stays out of graph resolution. */
export const RAW_RESOLVE = { storyhub: { raw: true } } as const;

type Container = { resolveId: (id: string, importer?: string, options?: Record<string, unknown>) => Promise<{ id: string; external?: boolean | string } | null> };

/** A ResolveFn backed by the dev server's own plugin pipeline (aliases, tsconfig paths, exports maps). */
export function viteResolver(server: ViteDevServer): ResolveFn {
    const container: Container = ((server as unknown as { environments?: { client?: { pluginContainer?: Container } } }).environments?.client?.pluginContainer ??
        (server as unknown as { pluginContainer: Container }).pluginContainer) as Container;
    return async (spec, importer) => {
        const r = await container.resolveId(spec, importer, { custom: RAW_RESOLVE, ssr: false });
        if (!r || r.external) return null;
        const id = cleanId(r.id);
        if (id.startsWith('\0') || !id.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(id)) return null;
        return id;
    };
}
