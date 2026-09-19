/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global assert, cuid, initTests, initCore, coreRequest, getNewFixture, charlatan */

const { integrity } = require('business');
const timestamp = require('unix-timestamp');
const { pollUntil } = require('test-helpers');

describe('[AINT] Audit events integrity', function () {
  let user, username, password, access, appAccess;
  let personalToken;
  let fixtures;
  let eventsPath, accessesPath;
  let auditedEvent;

  const streamId = 'yo';
  const now = timestamp.now();

  before(async function () {
    await initTests();
    await initCore();
    password = cuid();
    fixtures = getNewFixture();
    user = await fixtures.user(charlatan.Lorem.characters(7), {
      password
    });

    username = user.attrs.username;
    await user.stream({ id: streamId, name: 'YO' });
    access = await user.access({
      type: 'personal',
      token: cuid()
    });
    personalToken = access.attrs.token;
    await user.session(personalToken);
    user = user.attrs;
    accessesPath = '/' + username + '/accesses/';
    eventsPath = '/' + username + '/events/';

    const res = await coreRequest.post(accessesPath)
      .set('Authorization', personalToken)
      .send({ type: 'app', name: 'app access', token: 'app-token', permissions: [{ streamId, level: 'manage' }] });
    appAccess = res.body.access;
  });

  after(async function () {
    await fixtures.clean();
  });

  function validPost (path) { return coreRequest.post(path).set('Authorization', appAccess.token); }

  // The audit row of a call is written after its response is sent: re-read
  // until the row of `action` has landed. The reads are audited too, so only
  // that action's rows are kept.
  async function getAuditRows (token, streams, action) {
    const res = await pollUntil(
      () => coreRequest.get(eventsPath).set('Authorization', token).query({ fromTime: now, streams }),
      (res) => (res.body?.events ?? []).some((e) => e.content?.action === action)
    );
    return (res.body?.events ?? []).filter((e) => e.content?.action === action);
  }

  before(async () => {
    auditedEvent = (await validPost(eventsPath).send({ streamIds: [streamId], type: 'count/generic', content: 2 })).body.event;
  });

  it('[XLEL] created access has integrity', async () => {
    assert.ok(appAccess.integrity);
  });

  it('[ZKVC] created event has integrity', async () => {
    assert.ok(auditedEvent.integrity);
  });

  it('[WNWM] must find event integrity key and record value in the audit log ', async () => {
    const rows = await getAuditRows(appAccess.token, ':_audit:', 'events.create');
    assert.strictEqual(1, rows.length);

    const auditEvent = rows[0];
    assert.ok(auditEvent.content.record);
    assert.strictEqual(auditedEvent.integrity, auditEvent.content.record.integrity);

    const computedIntegrity = integrity.events.compute(auditedEvent);
    assert.strictEqual(computedIntegrity.integrity, auditEvent.content.record.integrity);
    assert.strictEqual(computedIntegrity.key, auditEvent.content.record.key);
  });

  it('[U09J] must find access integrity key and record value in the audit log ', async () => {
    const rows = await getAuditRows(personalToken, ':_audit:action-accesses.create', 'accesses.create');
    assert.strictEqual(1, rows.length);

    const auditEvent = rows[0];
    assert.ok(auditEvent.content.record);
    assert.strictEqual(appAccess.integrity, auditEvent.content.record.integrity);

    const computedIntegrity = integrity.accesses.compute(appAccess);
    assert.strictEqual(computedIntegrity.integrity, auditEvent.content.record.integrity);
    assert.strictEqual(computedIntegrity.key, auditEvent.content.record.key);
  });
});
