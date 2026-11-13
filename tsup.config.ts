import { defineConfig } from 'tsup';

export default defineConfig([
    {
        entry: { index: 'src/index.ts', preset: 'src/preset.ts', cli: 'src/cli.ts', vite: 'src/vite/index.ts', webpack: 'src/webpack/index.ts', tailwind: 'src/tailwind.ts' },
        format: 'esm',
        platform: 'node',
        target: 'node20',
        dts: { entry: { index: 'src/index.ts', vite: 'src/vite/index.ts', webpack: 'src/webpack/index.ts', tailwind: 'src/tailwind.ts' } },
        sourcemap: true,
        splitting: true,
        external: [/^storybook(\/|$)/, 'vite', 'webpack']
    },
    {
        // webpack loads loaders with require(), and Tailwind 3 loads its config the same way
        entry: { 'webpack-loader': 'src/webpack/loader.ts', tailwind: 'src/tailwind.ts' },
        format: 'cjs',
        platform: 'node',
        target: 'node20',
        outExtension: () => ({ js: '.cjs' }),
        external: [/^storybook(\/|$)/, 'webpack']
    },
    {
        entry: { manager: 'src/manager.ts' },
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        external: [/^storybook(\/|$)/]
    }
]);
