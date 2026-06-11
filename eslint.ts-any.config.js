/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// TypeScript `any` gate — run via `just lint-ts-any` (part of `just lint`).
//
// Kept separate from eslint.config.js on purpose: adding a `files: ['**/*.ts']`
// block there would make every pattern-less neostandard style config apply to
// .ts files too (style of .ts is tsc + convention, not eslint, for now).
// This config applies exactly one rule: explicit `any` is banned in TS
// sources. The few legitimate escape hatches carry a justified
// eslint-disable comment in place.
const tseslint = require('typescript-eslint');
const { plugins: neostandardPlugins } = require('neostandard');

module.exports = [
  {
    files: ['components/**/*.ts', 'storages/**/*.ts'],
    ignores: ['components/test-helpers/**', 'components/**/test-helpers/**', '**/node_modules/**'],
    languageOptions: {
      parser: tseslint.parser
    },
    linterOptions: {
      // Sources carry disable comments for the full neostandard rule set,
      // which this single-rule pass does not run.
      reportUnusedDisableDirectives: 'off'
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      // Loaded so existing `eslint-disable n/...` comments resolve.
      n: neostandardPlugins.n
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error'
    }
  }
];
