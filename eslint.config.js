import js from '@eslint/js';
import globals from 'globals';

/**
 * Flat config covering both workspaces.
 *
 * Deliberately modest: correctness rules only. Prettier owns formatting, so
 * there are no style rules here to argue with it.
 */
export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'],
  },

  js.configs.recommended,

  {
    // Server — Node, ES modules.
    files: ['server/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },

  {
    // Web — browser, ES modules.
    files: ['web/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },

  {
    // Repo-level scripts — Node, ES modules. Same rules as the server: they
    // are Node programs that happen to live outside a workspace, and until
    // this block existed `scripts/*.mjs` was linted by nothing at all.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },

  {
    // Browser tests. They sit under `web/`, so the block above has already
    // given them browser globals — which they do need, because the bodies of
    // `page.evaluate` callbacks are real browser code. But the files
    // themselves are Node programs run by Playwright, so they need BOTH: the
    // harness spawns a server with `process`/`node:fs`, and every spec uses
    // Node's module system.
    files: ['web/e2e/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
  },

  {
    // Config files run in Node regardless of which workspace they sit in.
    files: ['**/*.config.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
];
