import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export interface ParsedModule {
    hasModuleSyntax: boolean;
    staticImports: Array<{ moduleRequest: { value: string }; entries: Array<{ isType: boolean }> }>;
    staticExports: Array<{ entries: Array<{ moduleRequest: { value: string } | null; isType: boolean }> }>;
    dynamicImports: Array<{ moduleRequest: { start: number; end: number } }>;
}
export type ParseSync = (filename: string, code: string) => { module: ParsedModule; errors: unknown[] };

let parser: ParseSync | null | undefined;
let loading: Promise<ParseSync | null> | undefined;

/**
 * storyhub ships no parser of its own: Storybook already depends on oxc-parser, so the copy it
 * installed is loaded through Storybook's own resolution. A regex fallback covers the case where
 * it cannot be found.
 */
export function loadParser(): Promise<ParseSync | null> {
    if (parser !== undefined) return Promise.resolve(parser);
    loading ??= (async () => {
        const self = createRequire(import.meta.url);
        const anchors = ['storybook/package.json', 'vite/package.json'];
        for (const anchor of anchors) {
            try {
                const entry = createRequire(self.resolve(anchor)).resolve('oxc-parser');
                const mod = (await import(pathToFileURL(entry).href)) as { parseSync?: ParseSync };
                if (typeof mod.parseSync === 'function') return (parser = mod.parseSync);
            } catch {
                // try the next anchor
            }
        }
        return (parser = null);
    })();
    return loading;
}

/** The loaded parser; null when unavailable (callers fall back to regex scanning). */
export const getParser = (): ParseSync | null => parser ?? null;
