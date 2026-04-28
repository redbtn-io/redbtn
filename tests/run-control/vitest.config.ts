import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['verbose'],
    fileParallelism: false,
    include: ['**/*.test.ts'],
    root: path.dirname(new URL(import.meta.url).pathname),
  },
});
