/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [OSFN] OAuth2: the permissions a scope grammar returns name known feature
 * permissions only. An unknown name is a contract error of the extension:
 * `invalid_scope` with the generic text, the detail on the server trail.
 */

import assert from 'node:assert/strict';
import * as extension from '../src/extension.ts';
import * as scopeGrammar from '../src/scopeGrammar.ts';
import { REGISTRY_DEFAULT_FORBIDDEN_FEATURES } from '../src/clientRegistry.ts';
import { FEATURE_PERMISSION_NAMES } from 'business/src/accesses/permissionSet.ts';

const CLIENT = {
  clientId: 'fpn-app',
  kind: 'registry',
  redirectUris: ['https://app.example.com/redirect'],
  scope: ['read/a'],
  grantTypes: ['authorization_code'],
  tokenEndpointAuthMethod: 'none',
  subjectType: 'public',
  updatedAt: 1,
};

let feature = 'webhooks';

function grammar () {
  return {
    apiVersion: 1,
    name: 'toy-features',
    scopeGrammar: {
      parse (scopeString) {
        const tokens = [...new Set(scopeString.split(/\s+/).filter((t) => t !== ''))];
        const permissions = tokens.map((t) => ({ streamId: t.slice(5), level: 'read' }));
        permissions.push({ feature, setting: 'forbidden' });
        return { ok: true, tokens, offer: { permissions } };
      },
      echo ({ requestedTokens }) { return requestedTokens; },
    },
  };
}

function resolve (scope = 'read/a') {
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
  try {
    return { r: scopeGrammar.resolveRequestedScope(CLIENT, scope), logged };
  } finally {
    console.error = orig;
  }
}

describe('[OSFN] OAuth2: feature permission names in a scope grammar offer', () => {
  beforeEach(() => {
    feature = 'webhooks';
    extension.setExtension(grammar());
    scopeGrammar._resetForTests();
  });
  afterEach(() => {
    extension._resetForTests();
  });

  it('[FPNF] an unknown feature name in the offer is refused as a contract error; a known one passes', () => {
    const ok = resolve();
    assert.equal(ok.r.ok, true, ok.r.description);
    feature = 'webhook';
    scopeGrammar._resetForTests();
    const { r, logged } = resolve();
    assert.equal(r.ok, false);
    assert.equal(r.description, 'scope could not be parsed');
    assert.equal(logged.length, 1, logged.join('\n'));
    assert.match(logged[0], /produced invalid permissions/);
    assert.match(logged[0], /unknown feature 'webhook'/);
  });

  it('[FPNG] the registry default forbids are known feature names', () => {
    for (const name of REGISTRY_DEFAULT_FORBIDDEN_FEATURES) {
      assert.ok(FEATURE_PERMISSION_NAMES.includes(name), name);
    }
  });
});
