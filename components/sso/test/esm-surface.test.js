/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [ESMD] openid-client v6 module-surface guard.
 *
 * openid-client@6 is ESM-only and this component imports it directly. An
 * upgrade that breaks the module system, or renames the functional v6 API
 * we consume, should fail fast here with a named test rather than as an
 * opaque boot-time crash the first time a provider is configured.
 */

import * as oidc from 'openid-client';
import assert from 'node:assert/strict';

describe('[ESMD] openid-client v6 module surface', () => {
  it('[ESMD1] loads as an ESM module namespace object', () => {
    assert.equal(typeof oidc, 'object');
    assert.notEqual(oidc, null);
  });

  it('[ESMD2] exposes the v6 functional API the sso component uses', () => {
    const used = [
      'discovery',
      'buildAuthorizationUrl',
      'authorizationCodeGrant',
      'randomPKCECodeVerifier',
      'calculatePKCECodeChallenge',
      'randomState',
      'randomNonce'
    ];
    for (const fn of used) {
      assert.equal(typeof oidc[fn], 'function', `openid-client.${fn} must be a function`);
    }
  });
});
