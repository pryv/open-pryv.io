/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const neostandard = require('neostandard');
const globals = require('globals');

module.exports = [
  ...neostandard({
    semi: true,
    ts: true
  }),
  {
    ignores: [
      'node_modules/**',
      '**/node_modules/**',
      'external-ressources/**',
      'dist/**'
    ]
  },
  {
    files: ['**/*.ts'],
    linterOptions: {
      // `no-explicit-any` disables belong to the `lint-ts-any` gate
      // (eslint.ts-any.config.js): this config would report them unused
      reportUnusedDisableDirectives: 'off'
    },
    rules: {
      // same options as the JS rule neostandard sets, plus export lists
      // written above the definitions
      '@typescript-eslint/no-use-before-define': ['error', { functions: false, classes: false, variables: false, allowNamedExports: true }],
      // tsc reports real redeclarations; this rule would also flag the
      // deliberate interface + value pair sharing one name
      '@typescript-eslint/no-redeclare': 'off',
      // `__ex_<name>` is the CommonJS-to-ESM re-export pattern
      // (`const __ex_x = require(...); export { __ex_x as x }`)
      camelcase: ['error', { allow: ['^UNSAFE_', '^__ex_'], properties: 'never', ignoreGlobals: true }]
    }
  },
  {
    files: ['**/test/**/*.js', '**/conformance/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.mocha,
        // Pattern C test helpers (from helpers-c.js)
        initTests: 'readonly',
        initCore: 'readonly',
        coreRequest: 'readonly',
        getNewFixture: 'readonly',
        assert: 'readonly',
        cuid: 'readonly',
        charlatan: 'readonly',
        sinon: 'readonly',
        path: 'readonly',
        _: 'readonly'
      }
    }
  }
];
