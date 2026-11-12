#!/usr/bin/env node
// Builds a throwaway git repo with a Storybook (react-vite) hub checkout plus several worktrees,
// each exercising one overlay scenario. Dependencies are installed once into test/.cache and
// cloned (copy-on-write on APFS) into every generated fixture, so regenerating is cheap.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const libRoot = resolve(here, '../..');
const cacheRoot = join(libRoot, 'test/.cache');

const git = (cwd, ...args) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', ...args], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8'
    });

const write = (root, files) => {
    for (const [rel, content] of Object.entries(files)) {
        const file = join(root, rel);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
    }
};

const libPkg = JSON.parse(readFileSync(join(libRoot, 'package.json'), 'utf8'));
const depsManifest = {
    name: 'storyhub-fixture-deps',
    private: true,
    type: 'module',
    dependencies: {
        react: libPkg.devDependencies.react,
        'react-dom': libPkg.devDependencies['react-dom'],
        storybook: libPkg.devDependencies.storybook,
        '@storybook/react-vite': libPkg.devDependencies.storybook,
        vite: libPkg.devDependencies.vite,
        typescript: libPkg.devDependencies.typescript,
        ...libPkg.dependencies
    }
};

/** Installs fixture dependencies once (hoisted node_modules, like npm/yarn) and returns the dir. */
export function ensureDeps() {
    const hash = createHash('sha1').update(JSON.stringify(depsManifest)).digest('hex').slice(0, 10);
    const dir = join(cacheRoot, `deps-${hash}`);
    if (existsSync(join(dir, 'node_modules/.storyhub-ready'))) return dir;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(depsManifest, null, 2));
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'onlyBuiltDependencies:\n  - esbuild\n');
    execFileSync('pnpm', ['install', '--config.node-linker=hoisted', '--config.minimum-release-age=10080', '--ignore-workspace'], { cwd: dir, stdio: 'inherit' });
    writeFileSync(join(dir, 'node_modules/.storyhub-ready'), '');
    return dir;
}

const cloneDir = (from, to) => {
    try {
        execFileSync('cp', ['-cR', from, to]); // APFS clone
    } catch {
        cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    }
};

/** Copies the built library into a fixture's node_modules the way a tarball install would. */
export function installLibrary(hubRoot) {
    if (!existsSync(join(libRoot, 'dist'))) throw new Error('storyhub is not built; run `pnpm build` first');
    const target = join(hubRoot, 'node_modules/storyhub');
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    for (const entry of ['package.json', 'preset.js', 'dist']) cpSync(join(libRoot, entry), join(target, entry), { recursive: true });
}

const hubFiles = {
    '.gitignore': 'node_modules\nstorybook-static\n',
    'package.json': JSON.stringify(
        {
            name: 'fixture-app',
            private: true,
            type: 'module',
            workspaces: ['packages/*'],
            dependencies: { react: depsManifest.dependencies.react, '@fixture/ui': 'workspace:*' },
            devDependencies: { storybook: depsManifest.dependencies.storybook, '@storybook/react-vite': depsManifest.dependencies['@storybook/react-vite'], storyhub: libPkg.version }
        },
        null,
        2
    ) + '\n',
    'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx', baseUrl: '.', paths: { '@/*': ['src/*'] } } }, null, 2) + '\n',
    '.storybook/main.ts': `import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
    stories: ['../src/**/*.stories.tsx'],
    addons: ['storyhub'],
    framework: '@storybook/react-vite',
    core: { disableTelemetry: true },
    viteFinal: async vite => {
        vite.resolve ??= {};
        vite.resolve.alias = { ...(vite.resolve.alias as object), '@': fileURLToPath(new URL('../src', import.meta.url)) };
        return vite;
    }
};
export default config;
`,
    '.storybook/preview.tsx': `import React from 'react';
import type { Preview } from '@storybook/react-vite';
import { ThemeContext } from '../src/theme';

const preview: Preview = {
    decorators: [Story => <ThemeContext.Provider value="dark"><Story /></ThemeContext.Provider>]
};
export default preview;
`,
    'src/theme.ts': `import { createContext, useContext } from 'react';
export const ThemeContext = createContext('default');
export const useTheme = () => useContext(ThemeContext);
`,
    'src/components/Button.tsx': `import React from 'react';
import { useTheme } from '../theme';
export const Button = ({ label }: { label: string }) => <button data-testid="button" data-theme={useTheme()}>{label} v1</button>;
`,
    'src/components/Label.tsx': `import React from 'react';
export const Label = ({ text }: { text: string }) => <span data-testid="label">label:{text}</span>;
`,
    'src/components/Card.tsx': `import React from 'react';
import { Button } from './Button';
import { Label } from '@/components/Label';
export const Card = () => <div data-testid="card"><Label text="card" /><Button label="Go" /></div>;
`,
    'src/components/Badge.tsx': `import React from 'react';
export const Badge = () => <em data-testid="badge">badge</em>;
`,
    'src/components/Panel.tsx': `import React from 'react';
import { Box } from '@fixture/ui';
export const Panel = () => <Box>panel</Box>;
`,
    'src/components/Button.stories.tsx': `import { Button } from './Button';
export default { title: 'Components/Button', component: Button };
export const Primary = { args: { label: 'Primary' } };
export const Secondary = { args: { label: 'Secondary' } };
`,
    'src/components/Card.stories.tsx': `import { Card } from './Card';
export default { title: 'Components/Card', component: Card };
export const Default = {};
`,
    'src/components/Badge.stories.tsx': `import { Badge } from './Badge';
export default { title: 'Components/Badge', component: Badge };
export const Default = {};
`,
    'src/components/Panel.stories.tsx': `import { Panel } from './Panel';
export default { title: 'Components/Panel', component: Panel };
export const Default = {};
`,
    'packages/ui/package.json': JSON.stringify({ name: '@fixture/ui', version: '0.0.0', type: 'module', main: 'src/index.ts' }, null, 2) + '\n',
    'packages/ui/src/index.ts': `export { Box } from './Box';\n`,
    'packages/ui/src/Box.tsx': `import React from 'react';
export const Box = ({ children }: { children: React.ReactNode }) => <section data-testid="box" data-version="1">{children}</section>;
`
};

const lateHubFiles = {
    'src/components/Panel.tsx': hubFiles['src/components/Panel.tsx'].replace('<Box>panel</Box>', '<Box>panel (main)</Box>'),
    'src/components/Late.tsx': `import React from 'react';
import { Button } from './Button';
export const Late = () => <div data-testid="late"><Button label="Late" /></div>;
`,
    'src/components/Late.stories.tsx': `import { Late } from './Late';
export default { title: 'Components/Late', component: Late };
export const Default = {};
`
};

/** Scenario worktrees: name → { files to write, files to delete, commit? } */
export const scenarios = {
    'feat-button': {
        commit: true,
        files: { 'src/components/Button.tsx': hubFiles['src/components/Button.tsx'].replace('{label} v1', '{label} v2') }
    },
    'feat-label': {
        commit: false, // uncommitted working-tree change, reached through the `@/` alias
        files: { 'src/components/Label.tsx': hubFiles['src/components/Label.tsx'].replace('label:{text}', 'LABEL:{text}') }
    },
    'feat-new': {
        commit: true,
        files: {
            'src/components/Chip.tsx': `import React from 'react';
export const Chip = () => <b data-testid="chip">chip</b>;
`,
            'src/components/Chip.stories.tsx': `import { Chip } from './Chip';
export default { title: 'Components/Chip', component: Chip };
export const Default = {};
`
        },
        delete: ['src/components/Badge.stories.tsx']
    },
    'feat-theme': {
        commit: true,
        // the preview decorator provides ThemeContext from this module: the branch must render with
        // its own preview so provider and consumers share one context instance
        files: { 'src/theme.ts': hubFiles['src/theme.ts'].replace("createContext('default')", "createContext('light')") }
    },
    'feat-ui': {
        commit: true,
        files: {
            'packages/ui/src/Box.tsx': hubFiles['packages/ui/src/Box.tsx'].replace('data-version="1"', 'data-version="2"'),
            'package.json': hubFiles['package.json'].replace('"private": true,', '"private": true,\n  "description": "drift",')
        }
    }
};

/**
 * Creates the fixture under `dir` and returns its paths.
 * @param {{ dir: string, scenarios?: string[], install?: boolean, library?: boolean }} opts
 */
export function createFixture({ dir, scenarios: only = Object.keys(scenarios), install = true, library = install }) {
    rmSync(dir, { recursive: true, force: true });
    const hub = join(dir, 'hub');
    mkdirSync(hub, { recursive: true });
    write(hub, hubFiles);
    git(hub, 'init', '-q', '-b', 'main');
    git(hub, 'add', '-A');
    git(hub, 'commit', '-q', '-m', 'init');

    if (install) {
        const deps = ensureDeps();
        cloneDir(join(deps, 'node_modules'), join(hub, 'node_modules'));
        mkdirSync(join(hub, 'node_modules/@fixture'), { recursive: true });
        symlinkSync('../../packages/ui', join(hub, 'node_modules/@fixture/ui'));
    }
    if (library) installLibrary(hub);

    const worktrees = {};
    for (const name of only) {
        const scenario = scenarios[name];
        const wt = join(dir, name);
        git(hub, 'worktree', 'add', '-q', '-b', name, wt);
        write(wt, scenario.files);
        for (const rel of scenario.delete ?? []) rmSync(join(wt, rel));
        if (scenario.commit) {
            git(wt, 'add', '-A');
            git(wt, 'commit', '-q', '-m', name);
        }
        worktrees[name] = wt;
    }
    // branches are opt-in; the scenarios are switched on the way a user would (`storyhub on`)
    for (const name of only) git(hub, 'config', '--add', 'storyhub.include', name);
    // main moves on after the branches split: a new story that imports Button exists only in the
    // hub, so branches that change Button must not offer it (it is absent from their worktrees)
    write(hub, lateHubFiles);
    git(hub, 'add', '-A');
    git(hub, 'commit', '-q', '-m', 'late hub story');
    return { dir, hub, worktrees };
}

export { git as runGit };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const dir = resolve(process.argv[2] ?? join(cacheRoot, 'fixture'));
    const result = createFixture({ dir, install: !process.argv.includes('--no-install') });
    console.log(JSON.stringify(result, null, 2));
}
