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

  /**
   * [OAUTH-ERR-MATRIX] one assertion per errorMap row, spelled out
   * explicitly — changing or removing a row deliberately breaks a
   * test so the OAuth-facing contract can't drift silently.
   */
  describe('[OAUTH-ERR-MATRIX] full row matrix', () => {
    const EXPECTED_ROWS = {
      // request shape / param validation
      'invalid-parameters-format': 'invalid_request',
      'invalid-method': 'invalid_request',
      'missing-required-fields': 'invalid_request',
      // client identification / authentication
      'unknown-client': 'invalid_client',
      'unknown-referenced-resource': 'invalid_client',
      'invalid-client-secret': 'invalid_client',
      'app-account-not-registered': 'invalid_client',
      // redirect_uri / response_type
      'invalid-redirect-uri': 'invalid_request',
      'unregistered-redirect-uri': 'invalid_request',
      'unsupported-response-type': 'unsupported_response_type',
      // scope
      'unknown-scope': 'invalid_scope',
      'scope-not-granted': 'invalid_scope',
      'scope-not-subset': 'invalid_scope',
      // grant
      'unsupported-grant-type': 'unsupported_grant_type',
      'invalid-authorization-code': 'invalid_grant',
      'expired-authorization-code': 'invalid_grant',
      'authorization-code-already-used': 'invalid_grant',
      'invalid-pkce-verifier': 'invalid_grant',
      'invalid-refresh-token': 'invalid_grant',
      'expired-refresh-token': 'invalid_grant',
      'revoked-refresh-token': 'invalid_grant',
      // consent
      'user-refused-consent': 'access_denied',
      // access control
      'mfa-required': 'unauthorized_client',
      'app-account-not-mfa-enrolled': 'unauthorized_client',
      // server-side
      'temporarily-unavailable': 'temporarily_unavailable',
      'internal-error': 'server_error',
      'platform-storage-unavailable': 'temporarily_unavailable',
      // resource-server (WWW-Authenticate on protected resources)
      'expired-access-token': 'invalid_token',
      'revoked-access-token': 'invalid_token',
      'unknown-access-token': 'invalid_token',
    };

    for (const [pryvId, oauthError] of Object.entries(EXPECTED_ROWS)) {
      it(`[OAUTH-ERR-MATRIX] ${pryvId} → ${oauthError}`, () => {
        assert.equal(mapError(pryvId), oauthError);
      });
    }

    it('[OAUTH-ERR-MATRIX-X] matrix covers exactly the errorMap rows (new row ⇒ new assertion)', () => {
      assert.deepEqual(
        Object.keys(errorMap).sort(),
        Object.keys(EXPECTED_ROWS).sort(),
        'errorMap rows and the explicit test matrix diverge — update EXPECTED_ROWS deliberately'
      );
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
