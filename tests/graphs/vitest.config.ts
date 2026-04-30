import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Vitest config for `validateGraphConfig` unit tests (Platform Pack Phase C).
 *
 * Pure-TS validator — no native module strip needed (vs the native-tools
 * config). Single-fork to keep mongoose lazy-load deterministic.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 10_000,
    reporters: ['verbose'],
    fileParallelism: false,
    include: ['**/*.test.ts'],
    root: path.dirname(new URL(import.meta.url).pathname),
  },
});
