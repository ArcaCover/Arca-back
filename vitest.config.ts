import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve workspace source without requiring a build first.
    conditions: ['development', 'import', 'node', 'default'],
  },
  test: {
    include: ['packages/*/tests/**/*.test.ts', 'apps/*/tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['packages/scoring/src/**', 'apps/api/src/**'],
      reporter: ['text', 'html'],
    },
  },
});
