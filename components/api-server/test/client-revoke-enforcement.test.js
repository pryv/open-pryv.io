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
 * working once the client is revoked (a PlatformDB tombstone), within the
 * per-core cache TTL — without waiting out the access-token TTL. Non-oauth
 * accesses and non-revoked clients are unaffected; re-registering the client
 * clears the revoke.
 */

/* global initTests, initCore, coreRequest, getNewFixture, cuid */

const assert = require('node:assert/strict');
const storage = require('oauth2/src/storage.ts');
const revokedCache = require('oauth2/src/revokedClientsCache.ts');

describe('[CRVK] operator client-revoke enforcement', function () {
  this.timeout(20000);

  let fixtures, username, personalToken, appToken, plainToken;
  const CLIENT_ID = 'revoke-e2e-' + Math.random().toString(36).slice(2, 8);

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = cuid();
    personalToken = cuid();
    appToken = cuid();
    plainToken = cuid();
    const user = await fixtures.user(username);
    await user.access({ token: personalToken, type: 'personal' });
    await user.session(personalToken);
    await user.stream({ id: 'health', name: 'Health' });
    // An oauth-session access for CLIENT_ID (the shape the token endpoint mints).
    await user.access({ type: 'app', token: appToken, name: 'oauth:' + CLIENT_ID, permissions: [{ streamId: 'health', level: 'read' }] });
    // A plain app access whose name is NOT oauth:* — must never be affected.
    await user.access({ type: 'app', token: plainToken, name: 'my-plain-app', permissions: [{ streamId: 'health', level: 'read' }] });
  });

  beforeEach(function () { revokedCache._resetForTests(); });

  after(async function () {
    // Leave no tombstone behind for sibling suites.
    try { await storage.setClient(require('storages').platformDB, clientRow()); } catch { /* ignore */ }
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

  it('[CRVK5] re-registering the client clears the tombstone; the token works again', async function () {
    await storage.deleteClient(platform(), CLIENT_ID);
    revokedCache._resetForTests();
    assert.equal((await accessInfo(appToken)).status, 403);
    await storage.setClient(platform(), clientRow()); // re-register clears the tombstone
    revokedCache._resetForTests();
    assert.equal((await accessInfo(appToken)).status, 200);
  });
});
