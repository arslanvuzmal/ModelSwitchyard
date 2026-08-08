import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Three projects with different needs:
 *
 *  unit        — pure logic, no database, fast enough to run on every save.
 *  integration — real PostgreSQL; verifies persistence and the gateway path.
 *  security    — real PostgreSQL; asserts isolation and authorisation.
 *
 * Integration and security run single-threaded because they share one database
 * and would otherwise interfere with each other's row counts.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        resolve: {
          alias: { '@': fileURLToPath(new URL('./', import.meta.url)) },
        },
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: {
          alias: { '@': fileURLToPath(new URL('./', import.meta.url)) },
        },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/setup/database.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        resolve: {
          alias: { '@': fileURLToPath(new URL('./', import.meta.url)) },
        },
        test: {
          name: 'security',
          include: ['tests/security/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/setup/database.ts', 'tests/setup/security.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
