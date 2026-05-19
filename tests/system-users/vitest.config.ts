import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Vitest config for the system-user identity unit tests.
 *
 * Pure-TS module with no database — minimal config, mirrors tests/neurons.
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
