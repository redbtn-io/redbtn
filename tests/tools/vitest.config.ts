import { defineConfig } from 'vitest/config';
import path from 'path';
import type { Plugin } from 'vite';

/**
 * Strip `module.exports = ...` lines from native tool source files.
 * These tools use a dual export pattern (export default + module.exports)
 * for CJS compatibility, but it breaks vitest's ESM transform.
 *
 * Same plugin as tests/native-tools/vitest.config.ts — kept locally so this
 * config directory is independently runnable.
 */
function stripModuleExports(): Plugin {
  return {
    name: 'strip-module-exports',
    enforce: 'pre',
    transform(code, id) {
      if (id.includes('src/lib/tools/native/') && id.endsWith('.ts')) {
        const cleaned = code.replace(
          /^module\.exports\s*=\s*.+;?\s*$/gm,
          '// (module.exports stripped for ESM)',
        );
        if (cleaned !== code) {
          return { code: cleaned, map: null };
        }
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [stripModuleExports()],
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 30_000,
    reporters: ['verbose'],
    fileParallelism: false,
    include: ['**/*.test.ts'],
    root: path.dirname(new URL(import.meta.url).pathname),
  },
});
