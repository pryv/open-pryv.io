/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OAUTH-SCOPE] OAuth2 — pluggable scope-parser registry tests.
 */

const assert = require('node:assert/strict');
const {
  registerScopeParser,
  parseScopes,
  listNamespaces,
  ScopeParseError,
  _resetForTests,
} = require('../src/scopeRegistry.ts');

describe('[OAUTH-SCOPE] scope-parser registry', () => {
  beforeEach(() => { _resetForTests(); });

  describe('[OAUTH-SCOPE-1] default pryv parser', () => {
    it('[OAUTH-SCOPE-1a] parses pryv:read / pryv:write / pryv:manage', () => {
      const parsed = parseScopes('pryv:read pryv:write pryv:manage');
      assert.equal(parsed.length, 3);
      assert.deepEqual(parsed.map((s) => s.permission), ['read', 'write', 'manage']);
      for (const s of parsed) assert.equal(s.namespace, 'pryv');
    });
    it('[OAUTH-SCOPE-1b] rejects unknown pryv permission', () => {
      assert.throws(() => parseScopes('pryv:delete'), ScopeParseError);
    });
    it('[OAUTH-SCOPE-1c] ships pryv pre-registered', () => {
      assert.deepEqual(listNamespaces(), ['pryv']);
    });
  });

  describe('[OAUTH-SCOPE-2] empty + whitespace', () => {
    it('[OAUTH-SCOPE-2a] empty string → []', () => {
      assert.deepEqual(parseScopes(''), []);
    });
    it('[OAUTH-SCOPE-2b] non-string → []', () => {
      assert.deepEqual(parseScopes(null), []);
      assert.deepEqual(parseScopes(undefined), []);
    });
    it('[OAUTH-SCOPE-2c] multiple spaces / tabs / newlines collapse', () => {
      const parsed = parseScopes('pryv:read   pryv:write\tpryv:manage\n');
      assert.equal(parsed.length, 3);
    });
  });

  describe('[OAUTH-SCOPE-3] malformed tokens', () => {
    it('[OAUTH-SCOPE-3a] missing namespace prefix → ScopeParseError', () => {
      assert.throws(() => parseScopes('read'), ScopeParseError);
    });
    it('[OAUTH-SCOPE-3b] empty namespace prefix → ScopeParseError', () => {
      assert.throws(() => parseScopes(':read'), ScopeParseError);
    });
    it('[OAUTH-SCOPE-3c] unknown namespace → ScopeParseError', () => {
      assert.throws(() => parseScopes('foo:bar'), ScopeParseError);
    });
  });

  describe('[OAUTH-SCOPE-4] extension via registerScopeParser', () => {
    it('[OAUTH-SCOPE-4a] registers and parses a new namespace', () => {
      registerScopeParser('smart', (body) => ({
        namespace: 'smart',
        raw: `smart:${body}`,
        permission: 'read',
        smartBody: body,
      }));
      const parsed = parseScopes('smart:patient/Observation.read');
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].namespace, 'smart');
      assert.equal(parsed[0].smartBody, 'patient/Observation.read');
    });
    it('[OAUTH-SCOPE-4b] duplicate registration throws', () => {
      assert.throws(() => registerScopeParser('pryv', () => null), /already registered/);
    });
    it('[OAUTH-SCOPE-4c] mixed namespaces parse together', () => {
      registerScopeParser('smart', (body) => ({ namespace: 'smart', raw: `smart:${body}`, permission: 'read' }));
      const parsed = parseScopes('pryv:read smart:patient/Observation.read');
      assert.equal(parsed.length, 2);
      assert.equal(parsed[0].namespace, 'pryv');
      assert.equal(parsed[1].namespace, 'smart');
    });
  });

  describe('[OAUTH-SCOPE-5] registration validation', () => {
    it('[OAUTH-SCOPE-5a] empty namespace rejected', () => {
      assert.throws(() => registerScopeParser('', () => null));
    });
    it('[OAUTH-SCOPE-5b] non-function parser rejected', () => {
      assert.throws(() => registerScopeParser('x', 'not a function'));
    });
  });
});
