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

  describe('[OAUTH-SCOPE-1] default namespaces', () => {
    it('[OAUTH-SCOPE-1a] coarse pryv:* scopes no longer exist', () => {
      assert.throws(() => parseScopes('pryv:read'), ScopeParseError);
    });
    it('[OAUTH-SCOPE-1c] ships only cmc pre-registered', () => {
      assert.deepEqual(listNamespaces(), ['cmc']);
    });
  });

  describe('[OAUTH-SCOPE-6] default cmc parser', () => {
    it('[OAUTH-SCOPE-6a] parses cmc:<offer-name> into an offer reference', () => {
      const parsed = parseScopes('cmc:study-A.v2');
      assert.equal(parsed.length, 1);
      assert.deepEqual(parsed[0], {
        namespace: 'cmc',
        raw: 'cmc:study-A.v2',
        permission: 'granular',
        offerName: 'study-A.v2',
      });
    });
    it('[OAUTH-SCOPE-6b] rejects malformed offer names', () => {
      assert.throws(() => parseScopes('cmc:'), ScopeParseError);
      assert.throws(() => parseScopes('cmc:-leading-dash'), ScopeParseError);
      assert.throws(() => parseScopes('cmc:has space'), ScopeParseError); // splits into 2 tokens; 2nd has no namespace
      assert.throws(() => parseScopes('cmc:' + 'x'.repeat(65)), ScopeParseError);
      assert.throws(() => parseScopes('cmc:bad/slash'), ScopeParseError);
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
      const parsed = parseScopes('cmc:a   cmc:b\tcmc:c\n');
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
      assert.throws(() => registerScopeParser('cmc', () => null), /already registered/);
    });
    it('[OAUTH-SCOPE-4c] mixed namespaces parse together', () => {
      registerScopeParser('smart', (body) => ({ namespace: 'smart', raw: `smart:${body}`, permission: 'read' }));
      const parsed = parseScopes('cmc:study-A smart:patient/Observation.read');
      assert.equal(parsed.length, 2);
      assert.equal(parsed[0].namespace, 'cmc');
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
