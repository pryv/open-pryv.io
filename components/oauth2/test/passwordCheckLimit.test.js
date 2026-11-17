/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [OPCL] OAuth2: client-secret checks share the server's password-check
 * slots. While they are busy, the token, introspection and revocation
 * endpoints answer 503 temporarily_unavailable with Retry-After: the secret
 * was not checked, so the answer is never invalid_client.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mintSecret, verifySecret } from '../src/clientSecret.ts';
import { guardRoute } from '../src/routes.ts';
import { handleIntrospect } from '../src/introspection.ts';
import { handleRevoke } from '../src/revocation.ts';
import { persistClient } from '../src/clientRegistry.ts';
import { setCode } from '../src/storage.ts';
import crypto from 'node:crypto';
const require = createRequire(import.meta.url);
const { handleToken } = require('../src/routes/token.ts');
const { encryption } = require('utils');

const ISSUER = 'https://core.example.com';

function fakeConfig () {
  const m = { 'service:api': ISSUER, 'core:id': 'core-a', 'oauth:accessTokenTTL': 3600 };
  return { get: (k) => m[k] };
}

function fakePlatform () {
  const kv = new Map();
  const state = new Map();
  return {
    async setAccessState (k, v, exp) { state.set(k, { value: v, expiresAt: exp }); },
    async setAccessStateIfAbsent (k, v, exp) { if (state.has(k)) return false; state.set(k, { value: v, expiresAt: exp }); return true; },
    async getAccessState (k) { return state.get(k) ?? null; },
    async deleteAccessState (k) { state.delete(k); },
    async consumeAccessState (k) { const e = state.get(k); state.delete(k); return e ?? null; },
    async setPlatformKv (k, v) { kv.set(k, v); },
    async getPlatformKv (k) { return kv.has(k) ? kv.get(k) : null; },
    async deletePlatformKv (k) { kv.delete(k); },
    async listPlatformKvKeys (p) { return [...kv.keys()].filter((k) => k.startsWith(p)); },
    async listPlatformKvEntries (p) { return [...kv.entries()].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({ key, value })); },
    async getAllCoreInfos () { return [{ id: 'core-a' }]; },
  };
}

function fakeRes () {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    headersSent: false,
    writableEnded: false,
    setHeader (k, v) { this.headers[k.toLowerCase()] = v; },
    end (b) { this.body = b ? JSON.parse(b) : null; this.headersSent = true; this.writableEnded = true; },
  };
}

const basic = (id, secret) => 'Basic ' + Buffer.from(id + ':' + secret).toString('base64');

/** Holds the only password-check slot until `release()`. */
function holdSlot () {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const held = encryption.withBcryptSlot(() => gate);
  return { release: () => { release(); return held; } };
}

function assertBusy (res) {
  assert.equal(res.statusCode, 503, JSON.stringify(res.body));
  assert.equal(res.body.error, 'temporarily_unavailable');
  assert.equal(res.headers['retry-after'], '5');
  assert.equal(res.headers['cache-control'], 'no-store');
}

describe('[OPCL] OAuth2: client-secret checks and the password-check slots', function () {
  this.timeout(10000);
  let secret;
  before(async () => { secret = await mintSecret(); });
  afterEach(() => encryption.configureBcryptLimit(null));

  it('[OPCL1] mintSecret and verifySecret wait for a held slot, and complete once it is released', async () => {
    encryption.configureBcryptLimit({ concurrency: 1, queue: 10 });
    const slot = holdSlot();
    let minted = null;
    let verified = null;
    const m = mintSecret().then((v) => { minted = v; });
    const v = verifySecret(secret.plaintext, secret.hash).then((r) => { verified = r; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(minted, null);
    assert.equal(verified, null);
    assert.deepEqual(encryption.bcryptLimitStats(), { running: 1, waiting: 2 });
    await slot.release();
    await Promise.all([m, v]);
    assert.equal(typeof minted.hash, 'string');
    assert.equal(verified, true);
  });

  it('[OPCL2] the token endpoint (client secret) answers 503 temporarily_unavailable, not invalid_client', async () => {
    const platform = fakePlatform();
    await platform.setPlatformKv('oauth-client/myapp', JSON.stringify({
      clientId: 'myapp',
      redirectUris: ['x'],
      scope: ['pryv:read'],
      grantTypes: ['client_credentials'],
      accountUserId: 'u-myapp',
      clientSecretHash: secret.hash,
    }));
    const handler = guardRoute(handleToken({
      config: fakeConfig(),
      platform,
      mintClientAccess: async () => { throw new Error('not expected'); },
      resolveAccountUserId: async () => 'u-myapp',
      resolveUsername: async () => 'myapp',
    }));
    encryption.configureBcryptLimit({ concurrency: 1, queue: 0 });
    const slot = holdSlot();
    const res = fakeRes();
    await handler({ body: { grant_type: 'client_credentials' }, headers: { authorization: basic('myapp', secret.plaintext) } }, res, () => {});
    await slot.release();
    assertBusy(res);
  });

  it('[OPCL4] a code exchange refused for busy slots answers 503 and still revokes the access of the spent code', async () => {
    const platform = fakePlatform();
    await platform.setPlatformKv('oauth-client/myapp', JSON.stringify({ clientId: 'myapp', clientSecretHash: secret.hash }));
    const verifier = 'verifier-1234567890-abcdefg-hijklmnop-qrstuv';
    await setCode(platform, 'CODE-OPCL4', {
      clientId: 'myapp',
      redirectUri: 'https://app.example/cb',
      codeChallenge: crypto.createHash('sha256').update(verifier).digest('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_'),
      codeChallengeMethod: 'S256',
      userId: 'u-alice',
      scope: ['pryv:read'],
      expiresAt: Date.now() + 60_000,
      accessId: 'acc-u-alice',
      coreId: 'core-a',
    });
    const revoked = [];
    const handler = guardRoute(handleToken({
      config: fakeConfig(),
      platform,
      resolveAccess: async () => ({ accessToken: 'tok', apiEndpoint: 'https://alice.example.com/' }),
      revokeAccessLocal: async (p) => { revoked.push(p.accessId); },
      resolveUsername: async (userId) => (userId === 'u-alice' ? 'alice' : null),
    }));
    encryption.configureBcryptLimit({ concurrency: 1, queue: 0 });
    const slot = holdSlot();
    const res = fakeRes();
    await handler({
      body: {
        grant_type: 'authorization_code',
        code: 'CODE-OPCL4',
        code_verifier: verifier,
        client_id: 'myapp',
        redirect_uri: 'https://app.example/cb',
        client_secret: secret.plaintext,
      },
      headers: {},
    }, res, () => {});
    await slot.release();
    assertBusy(res);
    assert.deepEqual(revoked, ['acc-u-alice']);
  });

  it('[OPCL3] introspection and revocation answer 503 temporarily_unavailable, not invalid_client', async () => {
    const platform = fakePlatform();
    await persistClient(platform, {
      clientId: 'resource-srv',
      kind: 'registry',
      redirectUris: ['https://app.example.com/redirect'],
      scope: ['read/a'],
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod: 'client_secret_basic',
      clientSecretHash: secret.hash,
      canIntrospect: true,
      allowedAudiences: ['https://resource.example.com/base'],
      subjectType: 'public',
    });
    const introspect = guardRoute(handleIntrospect({
      config: fakeConfig(), platform, introspectAccess: async () => null, coreUrlFor: async (id) => 'https://' + id,
    }));
    const revoke = guardRoute(handleRevoke({
      config: fakeConfig(), platform, revokeSession: async () => false, coreUrlFor: async (id) => 'https://' + id,
    }));
    encryption.configureBcryptLimit({ concurrency: 1, queue: 0 });
    const slot = holdSlot();
    const req = () => ({ headers: { authorization: basic('resource-srv', secret.plaintext) }, body: { token: 'some-token' } });
    const r1 = fakeRes();
    await introspect(req(), r1, () => {});
    const r2 = fakeRes();
    await revoke(req(), r2, () => {});
    await slot.release();
    assertBusy(r1);
    assertBusy(r2);
    // Slots free again: the same client authenticates (a 200 answer).
    const r3 = fakeRes();
    await revoke(req(), r3, () => {});
    assert.equal(r3.statusCode, 200, JSON.stringify(r3.body));
  });
});
