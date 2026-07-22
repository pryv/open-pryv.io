/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [CRVK] Resource-server enforcement of an operator client revoke.
 *
 * An access minted for an OAuth client (`name = 'oauth:<clientId>'`) stops
 * working once the client is revoked (a PlatformDB tombstone carrying a revoke
 * epoch), within the per-core cache TTL — without waiting out the access-token
 * TTL. Non-oauth accesses and non-revoked clients are unaffected. Revoke is a
 * token EPOCH: re-registering the client does NOT resurrect its old tokens
 * (minted before the epoch); only freshly-minted ones work. An oauth-session
 * access cannot be renamed to dodge the check.
 */

/* global initTests, initCore, coreRequest, getNewFixture, cuid */

const assert = require('node:assert/strict');
const storage = require('oauth2/src/storage.ts');
const revokedCache = require('oauth2/src/revokedClientsCache.ts');

describe('[CRVK] operator client-revoke enforcement', function () {
  this.timeout(20000);

  let fixtures, username, personalToken, appToken, plainToken, user, oauthAccessId, plainAccessId;
  const CLIENT_ID = 'revoke-e2e-' + Math.random().toString(36).slice(2, 8);

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = cuid();
    personalToken = cuid();
    appToken = cuid();
    plainToken = cuid();
    user = await fixtures.user(username);
    await user.access({ token: personalToken, type: 'personal' });
    await user.session(personalToken);
    await user.stream({ id: 'health', name: 'Health' });
    // An oauth-session access for CLIENT_ID (the shape the token endpoint mints).
    const oauthAcc = await user.access({ type: 'app', token: appToken, name: 'oauth:' + CLIENT_ID, permissions: [{ streamId: 'health', level: 'read' }] });
    oauthAccessId = oauthAcc.attrs.id;
    // A plain app access whose name is NOT oauth:* — must never be affected.
    const plainAcc = await user.access({ type: 'app', token: plainToken, name: 'my-plain-app', permissions: [{ streamId: 'health', level: 'read' }] });
    plainAccessId = plainAcc.attrs.id;
  });

  beforeEach(function () { revokedCache._resetForTests(); });

  after(async function () {
    // Drop the tombstone so it doesn't linger in the shared PlatformDB.
    try { await require('storages').platformDB.deletePlatformKv('oauth-client-revoked/' + CLIENT_ID); } catch { /* ignore */ }
    if (fixtures) await fixtures.context.cleanEverything();
  });

  function clientRow () {
    return { clientId: CLIENT_ID, redirectUris: ['https://a/cb'], scope: ['cmc:x'], grantTypes: ['authorization_code'], clientName: 'X', updatedAt: Date.now() };
  }
  const accessInfo = (token) => coreRequest.get('/' + username + '/access-info').set('Authorization', token);
  const platform = () => require('storages').platformDB;

  it('[CRVK1] before revoke, the oauth-session token works', async function () {
    const res = await accessInfo(appToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  it('[CRVK2] after revoke, the same live token is rejected 403 (no waiting out the TTL)', async function () {
    await storage.deleteClient(platform(), CLIENT_ID); // operator revoke
    revokedCache._resetForTests(); // simulate the TTL having elapsed (cold reload)
    const res = await accessInfo(appToken);
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  it('[CRVK3] a non-oauth access (name not oauth:*) is unaffected by the revoke', async function () {
    await storage.deleteClient(platform(), CLIENT_ID);
    revokedCache._resetForTests();
    const res = await accessInfo(plainToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  it('[CRVK4] a personal token is unaffected', async function () {
    await storage.deleteClient(platform(), CLIENT_ID);
    revokedCache._resetForTests();
    const res = await accessInfo(personalToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  it('[CRVK5] token epoch: re-registering does NOT resurrect old tokens, but a freshly-minted one works', async function () {
    await storage.deleteClient(platform(), CLIENT_ID); // revoke (epoch = now)
    revokedCache._resetForTests();
    assert.equal((await accessInfo(appToken)).status, 403, 'old token stays dead');

    // Re-register the client — this must NOT resurrect the old (pre-revoke) token.
    await storage.setClient(platform(), clientRow());
    revokedCache._resetForTests();
    assert.equal((await accessInfo(appToken)).status, 403, 'old token still dead after re-register');

    // A token minted AFTER the revoke epoch (created > revokedAt) is honoured.
    const freshToken = cuid();
    await user.access({
      type: 'app',
      token: freshToken,
      name: 'oauth:' + CLIENT_ID,
      deviceName: 'oauth-session-fresh', // (name,type,deviceName) is unique; mints differ by device
      permissions: [{ streamId: 'health', level: 'read' }],
      created: Math.floor(Date.now() / 1000) + 3600, // clearly past the epoch
    });
    revokedCache._resetForTests();
    assert.equal((await accessInfo(freshToken)).status, 200, 'a token minted after the revoke works');
  });

  it('[CRVK6] an oauth-session access cannot be renamed (no dodging revoke by stripping the prefix)', async function () {
    const rename = await coreRequest
      .put('/' + username + '/accesses/' + oauthAccessId)
      .set('Authorization', personalToken)
      .send({ name: 'renamed-to-dodge' });
    assert.equal(rename.status, 403, JSON.stringify(rename.body));
    // Renaming a NON-oauth access is still allowed.
    const ok = await coreRequest
      .put('/' + username + '/accesses/' + plainAccessId)
      .set('Authorization', personalToken)
      .send({ name: 'plain-renamed' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });
});
