/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OAUTH-ERR] OAuth2 — error-map tests.
 */

const assert = require('node:assert/strict');
const { mapError, buildErrorResponse, errorMap } = require('../src/errorMap.ts');

describe('[OAUTH-ERR] error map', () => {
  describe('[OAUTH-ERR-1] mapError', () => {
    it('[OAUTH-ERR-1a] maps known Pryv error.ids to RFC 6749 enum', () => {
      assert.equal(mapError('unknown-client'), 'invalid_client');
      assert.equal(mapError('invalid-pkce-verifier'), 'invalid_grant');
      assert.equal(mapError('user-refused-consent'), 'access_denied');
      assert.equal(mapError('unsupported-grant-type'), 'unsupported_grant_type');
      assert.equal(mapError('expired-access-token'), 'invalid_token');
    });
    it('[OAUTH-ERR-1b] unknown error.id → invalid_request fallback', () => {
      assert.equal(mapError('some-random-unmapped-error'), 'invalid_request');
    });
    it('[OAUTH-ERR-1c] empty / non-string input → invalid_request fallback', () => {
      assert.equal(mapError(''), 'invalid_request');
      assert.equal(mapError(null), 'invalid_request');
      assert.equal(mapError(undefined), 'invalid_request');
      assert.equal(mapError(42), 'invalid_request');
    });
  });

  describe('[OAUTH-ERR-2] buildErrorResponse', () => {
    it('[OAUTH-ERR-2a] required error field only', () => {
      assert.deepEqual(buildErrorResponse('invalid_grant'), { error: 'invalid_grant' });
    });
    it('[OAUTH-ERR-2b] with description', () => {
      assert.deepEqual(buildErrorResponse('invalid_request', 'missing redirect_uri'), {
        error: 'invalid_request',
        error_description: 'missing redirect_uri',
      });
    });
    it('[OAUTH-ERR-2c] with description + uri', () => {
      assert.deepEqual(
        buildErrorResponse('invalid_grant', 'pkce verifier mismatch', 'https://docs/oauth2#pkce'),
        { error: 'invalid_grant', error_description: 'pkce verifier mismatch', error_uri: 'https://docs/oauth2#pkce' }
      );
    });
    it('[OAUTH-ERR-2d] null description / uri omitted', () => {
      assert.deepEqual(buildErrorResponse('invalid_grant', undefined, undefined), { error: 'invalid_grant' });
    });
  });

  describe('[OAUTH-ERR-3] map coverage', () => {
    it('[OAUTH-ERR-3a] every entry maps to a valid RFC 6749 enum value', () => {
      const validEnums = new Set([
        'invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client',
        'unsupported_grant_type', 'invalid_scope', 'access_denied', 'unsupported_response_type',
        'server_error', 'temporarily_unavailable', 'invalid_token', 'insufficient_scope',
      ]);
      for (const [pryvId, oauthError] of Object.entries(errorMap)) {
        assert.ok(validEnums.has(oauthError), `errorMap[${pryvId}] = ${oauthError} not in RFC 6749 enum`);
      }
    });
    it('[OAUTH-ERR-3b] no duplicate keys (typo guard)', () => {
      const keys = Object.keys(errorMap);
      assert.equal(keys.length, new Set(keys).size, 'duplicate Pryv error.id in errorMap');
    });
  });
});
