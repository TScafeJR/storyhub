import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
// @ts-expect-error untyped fixture script
import { createFixture } from './fixtures/create-fixture.mjs';

export interface Fixture {
    dir: string;
    hub: string;
    worktrees: Record<string, string>;
}

export function makeFixture(opts: { install?: boolean; library?: boolean; scenarios?: string[]; builder?: 'vite' | 'webpack' } = {}): Fixture {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'storyhub-')));
    return createFixture({ dir, ...opts }) as Fixture;
}

/** A bare Vite dev server over the fixture hub, used only for its resolver. */
export async function resolverServer(hub: string): Promise<ViteDevServer> {
    return createServer({
        root: hub,
        configFile: false,
        logLevel: 'silent',
        appType: 'custom',
        resolve: { alias: { '@': join(hub, 'src') } },
        server: { middlewareMode: true, watch: null, hmr: false },
        optimizeDeps: { noDiscovery: true, include: [] }
    });
}
