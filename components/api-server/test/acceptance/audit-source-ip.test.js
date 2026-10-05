/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const { getConfig } = require('@pryv/boiler');
const { pollUntil } = require('test-helpers');
const { configureTrustedProxies, currentTrustedProxies } = require('middleware/src/clientIp.ts');

/**
 * The audit log's `source.ip` honours X-Forwarded-For only from a trusted
 * proxy (http.trustedProxies, default loopback). Test requests reach the core
 * from 127.0.0.1, so they stand for a proxy on the same host; trusting nobody
 * turns them into a client exposed directly, whose header must be ignored.
 */
describe('[ASIP] audit source ip behind trusted proxies', () => {
  let username, basePath, actionsToken, personalToken;
  let savedIntegrityCheck;
  let savedTrustedProxies = null; // the running list, read once the core has configured it

  before(async function () {
    savedIntegrityCheck = process.env.DISABLE_INTEGRITY_CHECK;
    process.env.DISABLE_INTEGRITY_CHECK = '1';
    await initTests();
    const config = await getConfig();
    if (!config.get('audit:active')) { this.skip(); return; }
    await initCore();
    savedTrustedProxies = currentTrustedProxies();
    const fixtures = getNewFixture();
    username = cuid();
    basePath = '/' + username;
    actionsToken = 'asip-actions-' + username;
    personalToken = cuid();
    const user = await fixtures.user(username);
    await user.stream({ id: 'asip', name: 'ASIP' });
    await user.access({ permissions: [{ streamId: '*', level: 'manage' }], token: actionsToken, type: 'app' });
    await user.access({ type: 'personal', token: personalToken });
    await user.session(personalToken);
  });

  after(async function () {
    if (savedTrustedProxies != null) configureTrustedProxies(savedTrustedProxies);
    const { getUsersRepository } = require('business/src/users/index.ts');
    await (await getUsersRepository()).deleteAll();
    if (savedIntegrityCheck != null) process.env.DISABLE_INTEGRITY_CHECK = savedIntegrityCheck;
    else delete process.env.DISABLE_INTEGRITY_CHECK;
  });

  // One audited events.get per case, told apart by its `limit`; the audit row
  // is written after the response, so poll for that specific row.
  async function recordedIp (marker, xff) {
    const req = coreRequest.get(basePath + '/events').set('Authorization', actionsToken).query({ limit: marker });
    if (xff != null) req.set('X-Forwarded-For', xff);
    assert.strictEqual((await req).status, 200);
    const isMarked = (e) => e.content?.query?.limit === marker;
    const rows = await pollUntil(
      async () => (await coreRequest
        .get(basePath + '/events')
        .set('Authorization', personalToken)
        .query({ streams: [':_audit:action-events.get'] })).body.events ?? [],
      (rows) => rows.some(isMarked));
    return rows.find(isMarked).content.source.ip;
  }

  it('[ASI1] no header: the peer address, in IPv4 form', async () => {
    assert.strictEqual(await recordedIp('11', null), '127.0.0.1');
  });

  it('[ASI2] header from a trusted (loopback) peer: the forwarded client', async () => {
    assert.strictEqual(await recordedIp('12', '203.0.113.7'), '203.0.113.7');
  });

  it('[ASI3] a client-supplied prefix in the chain is not believed', async () => {
    assert.strictEqual(await recordedIp('13', '1.2.3.4, 203.0.113.8'), '203.0.113.8');
  });

  it('[ASI4] trusting nobody: a directly exposed core ignores the header (spoof blocked)', async () => {
    configureTrustedProxies([]);
    try {
      assert.strictEqual(await recordedIp('14', '203.0.113.9'), '127.0.0.1');
    } finally {
      configureTrustedProxies(savedTrustedProxies);
    }
  });
});
