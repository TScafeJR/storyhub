import { defineConfig } from 'tsup';

export default defineConfig([
    {
        entry: { index: 'src/index.ts', preset: 'src/preset.ts', cli: 'src/cli.ts' },
        format: 'esm',
        platform: 'node',
        target: 'node20',
        dts: { entry: { index: 'src/index.ts' } },
        sourcemap: true,
        external: [/^storybook(\/|$)/, 'vite']
    },
    {
        entry: { manager: 'src/manager.ts' },
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        external: [/^storybook(\/|$)/]
    }
]);
