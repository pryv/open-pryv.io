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
    semi: true
  }),
  {
    ignores: [
      'build/test/pryv/*',
      'node_modules/**',
      '**/node_modules/**',
      'external-ressources/**',
      // Vendored as-is from pryv/pryv-boiler@1.2.4. Will be brought in line
      // with neostandard {semi:true} in follow-up commits as the module is
      // trimmed down (drop superagent ConfigRemoteURL path, drop unused
      // pluginAsync surface, drop airbrake stub).
      'components/boiler/**'
    ]
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
