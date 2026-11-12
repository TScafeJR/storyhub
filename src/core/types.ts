export type ChangeKind = 'A' | 'M' | 'D';

export interface FileChange {
    /** Path relative to the git root, forward slashes. */
    rel: string;
    kind: ChangeKind;
}

export type DriftFlag = 'deps-drift' | 'config-drift' | 'diverged' | 'missing-dep';

export interface Worktree {
    /** Stable, URL/ref-safe identifier ([a-z0-9-]). */
    id: string;
    /** Real (symlink-resolved) absolute path of the checkout. */
    path: string;
    head: string;
    /** Short branch name, or null when detached. */
    branch: string | null;
    isHub: boolean;
}

/**
 * Resolves an import specifier the way the builder does. Returns an absolute file path
 * (query stripped), or null when the import is external or unresolvable.
 */
export type ResolveFn = (spec: string, importer: string) => Promise<string | null>;

/** Builder adapter: everything storyhub needs from Vite, webpack, etc. */
export interface BuilderAdapter {
    resolve: ResolveFn;
}

export interface BranchState {
    worktree: Worktree;
    mergeBase: string;
    changes: FileChange[];
    drift: DriftFlag[];
    /** Files changed on both the hub and this branch since the merge base. */
    diverged: string[];
    /** Changed files plus every file that transitively imports one (git-root relative). */
    dirty: Set<string>;
    /** Story files (git-root relative) whose rendering this branch changes. */
    affectedStories: string[];
    /** Preview files (git-root relative) this branch must load from its worktree. */
    previewOverrides: string[];
    /** Bare imports this branch adds that the hub cannot resolve. */
    missingDeps: string[];
    error?: string;
}

export interface BranchSummary {
    id: string;
    branch: string | null;
    path: string;
    head: string;
    mergeBase: string;
    drift: DriftFlag[];
    changedFiles: number;
    affectedStories: number;
    refUrl: string;
    error?: string;
}
