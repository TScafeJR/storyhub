import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

export const toPosix = (p: string): string => (sep === '/' ? p : p.split(sep).join('/'));

export const realpath = (p: string): string => {
    try {
        return realpathSync.native(p);
    } catch {
        return p;
    }
};

/** Strips Vite-style query/hash suffixes and the /@fs prefix from a module id. */
export const cleanId = (id: string): string => {
    let out = id;
    const q = out.search(/[?#]/);
    if (q !== -1) out = out.slice(0, q);
    if (out.startsWith('/@fs/')) out = out.slice(4);
    return out;
};

/** Returns `file` relative to `root` (posix), or null if it is outside. */
export const relInside = (root: string, file: string): string | null => {
    const rel = relative(root, file);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    return toPosix(rel);
};

export const isNodeModules = (p: string): boolean => /[\\/]node_modules[\\/]/.test(p);

export const isRelativeSpec = (spec: string): boolean => spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..';

export const isBareSpec = (spec: string): boolean =>
    !isRelativeSpec(spec) && !isAbsolute(spec) && !spec.startsWith('/') && !spec.startsWith('\0') && !/^[a-z]+:/i.test(spec) && !spec.startsWith('#');

export const sanitizeId = (raw: string): string =>
    raw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'worktree';
