import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resuelve los workspaces a su fuente TS, para correr tests sin build previo.
    conditions: ['development', 'import', 'node', 'default'],
  },
  test: {
    include: ['packages/*/tests/**/*.test.ts', 'apps/*/tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['packages/scoring/src/**', 'packages/questions/src/**'],
      reporter: ['text', 'html'],
    },
  },
});
