import { beforeAll, describe, expect, it } from 'vitest';
import { classifyDrift } from '../../src/core/diff.js';
import { extractSpecs, importChain, regexSpecs, reverseClosure } from '../../src/core/graph.js';
import { loadParser } from '../../src/core/parser.js';
import { parseWorktreeList } from '../../src/core/worktrees.js';

describe('extractSpecs', () => {
    beforeAll(async () => {
        expect(await loadParser()).toBeTypeOf('function'); // resolved through Storybook's own oxc-parser
    });

    it('collects runtime imports, re-exports and literal dynamic imports, skipping type-only imports', () => {
        const code = `import type { X } from './types';
import { type Y, z } from './z';
import './side.css';
export { b } from './b';
export type { T } from './t';
export * from './c';
const C = () => <div>{String(import('./lazy'))}</div>;
import(variable);
const t: Array<number> = [];`;
        expect(extractSpecs('a.tsx', code).sort()).toEqual(['./b', './c', './lazy', './side.css', './z']);
    });

    it('reads script blocks from single-file components', () => {
        const vue = `<template><Foo/></template>\n<script setup lang="ts">import Foo from './Foo.vue';\nimport { ref } from 'vue';</script>`;
        expect(extractSpecs('Comp.vue', vue).sort()).toEqual(['./Foo.vue', 'vue']);
    });

    it('reads imports from MDX', () => {
        const mdx = `import { Meta } from '@storybook/addon-docs/blocks';\nimport * as Stories from './Button.stories';\n\n# Hello`;
        expect(extractSpecs('Button.mdx', mdx).sort()).toEqual(['./Button.stories', '@storybook/addon-docs/blocks']);
    });

    it('ignores non-script assets', () => {
        expect(extractSpecs('a.css', '@import "./b.css";')).toEqual([]);
    });
});

describe('regexSpecs fallback', () => {
    it('finds static, side-effect and dynamic imports without a parser', () => {
        const code = `import a from './a';\nimport type { T } from './t';\nimport './side.css';\nexport * from './c';\nconst l = import('./lazy');`;
        expect(regexSpecs(code).sort()).toEqual(['./a', './c', './lazy', './side.css']);
    });
});

describe('graph algorithms', () => {
    const edges = new Map([
        ['story.tsx', new Set(['card.tsx'])],
        ['card.tsx', new Set(['button.tsx', 'label.tsx'])],
        ['button.tsx', new Set<string>()],
        ['label.tsx', new Set<string>()],
        ['other.stories.tsx', new Set(['label.tsx'])]
    ]);

    it('reverseClosure returns everything that can reach a seed', () => {
        expect([...reverseClosure(edges, ['button.tsx'])].sort()).toEqual(['button.tsx', 'card.tsx', 'story.tsx']);
    });

    it('importChain finds the shortest path to a changed file', () => {
        expect(importChain(edges, 'story.tsx', new Set(['button.tsx']))).toEqual(['story.tsx', 'card.tsx', 'button.tsx']);
        expect(importChain(edges, 'other.stories.tsx', new Set(['button.tsx']))).toBeNull();
    });
});

describe('parseWorktreeList', () => {
    it('parses porcelain output', () => {
        const out = `worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo-feat\nHEAD def\ndetached\n\nworktree /bare\nbare\n\nworktree /gone\nHEAD 123\nbranch refs/heads/gone\nprunable gitdir file points to non-existent location\n`;
        expect(parseWorktreeList(out)).toEqual([
            { path: '/repo', head: 'abc', branch: 'main', bare: false, prunable: false },
            { path: '/repo-feat', head: 'def', branch: null, bare: false, prunable: false },
            { path: '/bare', head: '', branch: null, bare: true, prunable: false },
            { path: '/gone', head: '123', branch: 'gone', bare: false, prunable: true }
        ]);
    });
});

describe('classifyDrift', () => {
    it('flags dependency, config and divergence drift', () => {
        expect(classifyDrift([{ rel: 'apps/web/package.json', kind: 'M' }], 'apps/web/.storybook', [])).toEqual(['deps-drift']);
        expect(classifyDrift([{ rel: 'apps/web/.storybook/preview.tsx', kind: 'M' }], 'apps/web/.storybook', [])).toEqual(['config-drift']);
        expect(classifyDrift([{ rel: 'src/a.ts', kind: 'M' }], null, ['src/a.ts'])).toEqual(['diverged']);
        expect(classifyDrift([{ rel: 'src/a.ts', kind: 'M' }], null, [])).toEqual([]);
    });
});
