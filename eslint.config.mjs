// ESLint v9 flat config.
//
// The repo had no config at all, so `npm run lint:check` exited non-zero
// ("no eslint.config.*") and lint was effectively skipped everywhere — while the
// source still carried ~350 `eslint-disable` comments for rules that never ran.
//
// This is a baseline, not a style overhaul: the recommended rule sets are on and
// error by default, and the handful of rules the existing codebase violates are
// pinned to `warn` so lint is a real gate today instead of a red wall nobody can
// land against. Burning down the warnings is follow-up work, not this PR's.
//
// Named `.mjs` on purpose — the package is CommonJS (no `"type": "module"`), so a
// `.js` flat config would be ambiguous to load.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';

export default tseslint.config(
    {
        ignores: ['dist/**', 'node_modules/**', 'coverage/**', '**/*.d.ts'],
    },

    js.configs.recommended,
    ...tseslint.configs.recommended,

    {
        files: ['**/*.ts'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.node },
        },
        plugins: { 'unused-imports': unusedImports },
        linterOptions: {
            // ~150 of the pre-existing disable comments are for `no-explicit-any`,
            // which is off below. Reporting them as unused directives would just
            // trade one wall of noise for another.
            reportUnusedDisableDirectives: 'off',
        },
        rules: {
            // Graph state is user-authored, dynamically-shaped JSON — the engine is
            // deliberately `any` at that boundary. ~740 sites; not a lint problem.
            '@typescript-eslint/no-explicit-any': 'off',

            // TypeScript resolves identifiers itself; in .ts files `no-undef` only
            // fires false positives on type-land syntax.
            'no-undef': 'off',

            // Pre-existing debt — visible as warnings, not merge blockers.
            '@typescript-eslint/no-require-imports': 'warn',
            '@typescript-eslint/no-unused-vars': ['warn', {
                args: 'after-used',
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrors: 'none',
            }],
            '@typescript-eslint/no-unsafe-function-type': 'warn',
            'unused-imports/no-unused-imports': 'warn',
            'no-useless-escape': 'warn',
            'no-useless-catch': 'warn',
            'no-case-declarations': 'warn',
            'no-control-regex': 'warn',
            'no-empty': 'warn',
            'prefer-const': 'warn',
        },
    },

    {
        // src/lib/graphs/{conditionEvaluator,state}.js are hand-maintained CommonJS
        // modules copied verbatim into dist/ by the build script.
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
        rules: {
            '@typescript-eslint/no-require-imports': 'off',
        },
    },
);
