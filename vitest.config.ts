import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';

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
    include: ['tests/**/*.test.ts'],
    exclude: [
      'node_modules/**',
      'dist/**',
      '.claude/**',
      'tests/native-tools/native-tools.test.ts',
    ],
  },
});
