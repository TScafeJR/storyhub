import type { StoryHub } from '../core/state.js';

/**
 * State shared between the webpack plugin (loaded by the ESM preset) and the loader (loaded by
 * webpack as CommonJS, so a separate module instance). They meet on a global keyed by config dir.
 */
export interface WebpackSession {
    hub?: StoryHub;
    gitRoot: string;
    /** Absolute paths of the selected worktrees, kept current as the hub refreshes. */
    roots: string[];
}

const KEY = Symbol.for('storyhub.webpack.sessions');

export function sessions(): Map<string, WebpackSession> {
    const g = globalThis as unknown as Record<symbol, Map<string, WebpackSession> | undefined>;
    return (g[KEY] ??= new Map());
}
