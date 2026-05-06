import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Vitest config for capability-matrix + tool-resolver unit tests.
 *
 * These tests exercise pure-TS modules and don't require a database, so
 * we keep the config minimal and run files in parallel.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 10_000,
    hookTimeout: 10_000,
    reporters: ['verbose'],
    fileParallelism: false,
    include: ['**/*.test.ts'],
    root: path.dirname(new URL(import.meta.url).pathname),
  },
});
