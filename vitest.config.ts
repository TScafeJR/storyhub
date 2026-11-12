import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        projects: [
            { test: { name: 'unit', include: ['test/unit/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 300_000 } },
            { test: { name: 'e2e', include: ['test/e2e/**/*.test.ts'], testTimeout: 180_000, hookTimeout: 300_000, fileParallelism: false } }
        ]
    }
});
