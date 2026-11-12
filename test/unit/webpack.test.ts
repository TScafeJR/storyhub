import type { RuleSetRule } from 'webpack';
import { describe, expect, it } from 'vitest';
import { wrapRules } from '../../src/webpack/plugin.js';
import type { WebpackSession } from '../../src/webpack/session.js';

const session: WebpackSession = { gitRoot: '/repo', roots: ['/wt/feat'] };
const test = (rule: RuleSetRule, key: 'test' | 'include' | 'exclude' | 'issuer', path: string) => (rule[key] as (p: string) => boolean)(path);

describe('wrapRules', () => {
    it('evaluates worktree paths as their hub twins, leaving hub paths unchanged', () => {
        const rule: RuleSetRule = { test: /\.tsx?$/, include: '/repo/src', exclude: /node_modules/ };
        wrapRules([rule], session);
        // a worktree file gets exactly the loaders its hub twin would get
        expect(test(rule, 'include', '/wt/feat/src/Button.tsx')).toBe(true);
        expect(test(rule, 'include', '/repo/src/Button.tsx')).toBe(true);
        expect(test(rule, 'include', '/elsewhere/src/Button.tsx')).toBe(false);
        expect(test(rule, 'test', '/wt/feat/src/Button.tsx')).toBe(true);
        expect(test(rule, 'exclude', '/wt/feat/node_modules/x/index.js')).toBe(true);
    });

    it('supports arrays, functions and and/or/not conditions, and recurses into oneOf and rules', () => {
        const inner: RuleSetRule = { include: { and: ['/repo/src', { not: /\.test\./ }] } };
        const nested: RuleSetRule = { issuer: [p => p.endsWith('.mdx'), /\.stories\./] };
        const rule: RuleSetRule = { oneOf: [inner], rules: [nested] };
        wrapRules([rule, '...', false as never], session);
        expect(test(inner, 'include', '/wt/feat/src/a.tsx')).toBe(true);
        expect(test(inner, 'include', '/wt/feat/src/a.test.tsx')).toBe(false);
        expect(test(nested, 'issuer', '/wt/feat/src/Button.stories.tsx')).toBe(true);
        expect(test(nested, 'issuer', '/wt/feat/docs/intro.mdx')).toBe(true);
        expect(test(nested, 'issuer', '/wt/feat/src/Button.tsx')).toBe(false);
    });

    it('resets stateful RegExps so global flags do not skip matches', () => {
        const rule: RuleSetRule = { test: /\.tsx$/g };
        wrapRules([rule], session);
        expect(test(rule, 'test', '/repo/a.tsx')).toBe(true);
        expect(test(rule, 'test', '/repo/b.tsx')).toBe(true);
    });
});
