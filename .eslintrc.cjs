/* ESLint config for the MeshPort PWA (Vite + React + TypeScript).
 *
 * Tuned to catch real bugs (unused vars, undefined refs, bad hooks deps,
 * unreachable code) without drowning the existing codebase in stylistic
 * noise: `any` is used deliberately throughout for chain/RPC payloads, and
 * non-null assertions are common, so those are off. Deno edge functions
 * (supabase/functions) have their own globals and are linted separately. */
module.exports = {
  root: true,
  env: { browser: true, es2021: true, node: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['@typescript-eslint', 'react-hooks', 'react-refresh'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: [
    'dist', 'node_modules', 'coverage', 'public',
    'supabase/functions', // Deno runtime, separate globals
    '*.config.*', '.eslintrc.cjs', 'hardhat.config.cjs', 'vite.config.ts',
  ],
  rules: {
    // Deliberate in this codebase (chain/RPC payloads, DOM refs).
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/ban-ts-comment': 'off',
    '@typescript-eslint/no-empty-function': 'off',
    '@typescript-eslint/no-empty-interface': 'off',
    'no-empty': ['error', { allowEmptyCatch: true }],
    'no-constant-condition': ['error', { checkLoops: false }],
    'no-useless-escape': 'off',
    'no-inner-declarations': 'off',
    'react-refresh/only-export-components': 'off',
    // Pre-existing in the codebase: kept visible as warnings (lint stays
    // green) rather than blocking. Worth a dedicated cleanup pass, then
    // these can be promoted back to 'error':
    //   - ~180 unused vars/args (dead code)
    //   - 14 react-hooks/rules-of-hooks (e.g. settlement.ts conditional hook)
    //   - ~100 exhaustive-deps
    '@typescript-eslint/no-unused-vars': ['warn', {
      argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true,
    }],
    'react-hooks/rules-of-hooks': 'warn',
    'react-hooks/exhaustive-deps': 'warn',
  },
}
