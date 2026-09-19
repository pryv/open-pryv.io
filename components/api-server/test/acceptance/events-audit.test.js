/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Audit logs tests (Pattern C)
 * Run with: PATTERN_C_AUDIT=1 npx mocha --no-config --require test/helpers-c.js test/acceptance/events-audit.test.js
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid, charlatan */

const { getConfig } = require('@pryv/boiler');
const { pollUntil } = require('test-helpers');

describe('[AUDI] Audit logs events (Pattern C)', () => {
  let config;
  let username;
  let auditToken, actionsToken, personalToken;
  let streamId;
  let basePath;
  let fixtures;
  let savedIntegrityCheck;

  before(async function () {
    savedIntegrityCheck = process.env.DISABLE_INTEGRITY_CHECK;
    process.env.DISABLE_INTEGRITY_CHECK = '1';
    await initTests();
    config = await getConfig();

    // Skip if audit is not active
    if (!config.get('audit:active')) {
      this.skip();
      return;
    }

    await initCore();

    fixtures = getNewFixture();

    username = cuid();
    basePath = '/' + username;
    auditToken = 'audit-token-' + username;
    actionsToken = 'actions-token-' + username;
    personalToken = cuid();
    streamId = cuid();

    const user = await fixtures.user(username);
    const stream = await user.stream({ id: streamId, name: charlatan.Lorem.word() });
    await stream.event({
      type: 'language/iso-639-1',
      content: charlatan.Lorem.characters(2)
    });

    await user.access({
      permissions: [
        { streamId: '*', level: 'manage' },
        { streamId: ':_system:account', level: 'read' }
      ],
      token: actionsToken,
      type: 'app'
    });

    await user.access({
      permissions: [{ streamId: ':_audit:', level: 'read' }],
      token: auditToken,
      type: 'app'
    });

    await user.access({
      type: 'personal',
      token: personalToken
    });
    await user.session(personalToken);

    // Create some audit log entries
    await coreRequest
      .post(basePath + '/events')
      .set('Authorization', actionsToken)
      .send({ streamIds: [streamId], type: 'note/txt', content: charlatan.Lorem.text() });

    await coreRequest
      .get(basePath + '/events')
      .set('Authorization', actionsToken)
      .query({ trashed: false });
  });

  after(async function () {
    const { getUsersRepository } = require('business/src/users/index.ts');
    const usersRepository = await getUsersRepository();
    await usersRepository.deleteAll();
    if (savedIntegrityCheck != null) {
      process.env.DISABLE_INTEGRITY_CHECK = savedIntegrityCheck;
    } else {
      delete process.env.DISABLE_INTEGRITY_CHECK;
    }
  });

  // The audit row of a successful call is written after its response is sent:
  // re-read until `until` holds. These reads are audited too, so wait for a
  // specific call's row, not for any row.
  function getEventsGetAuditRows (until) {
    return pollUntil(
      async () => (await coreRequest
        .get(basePath + '/events')
        .set('Authorization', personalToken)
        .query({ streams: [':_audit:action-events.get'] })).body.events ?? [],
      until);
  }

  describe('[AU01] GET /events', () => {
    it('[0BK7] must not return null values or trashed=false', async () => {
      // the setup's `trashed: false` read
      const isSetupRead = (e) => e.content?.query?.trashed === 'false';
      const events = await getEventsGetAuditRows((rows) => rows.some(isSetupRead));
      const event = events.find(isSetupRead);
      assert.ok(event, 'Should have the audit event of the setup read');

      for (const [key, val] of Object.entries(event)) {
        assert.ok(val !== null, `Property ${key} should not be null`);
      }
      if (event.trashed != null && event.trashed === false) {
        assert.fail('trashed=false should not be present');
      }
    });

    it('[VBV0] must not return "auth" in "content:query"', async () => {
      // Make a request with auth in query; the unusual limit marks its audit row
      const marker = '13';
      await coreRequest
        .get(basePath + '/events')
        .query({ auth: actionsToken, limit: marker });

      const isMarked = (e) => e.content?.query?.limit === marker;
      const rows = await getEventsGetAuditRows((rows) => rows.some(isMarked));
      const event = rows.find(isMarked);
      assert.ok(event, 'audit row of the call with auth in query');
      assert.ok(!('auth' in (event.content?.query || {})), 'Token in query should not be present in audit log');
    });

    it('[R8MS] must escape special characters', async () => {
      // Trailing " (quote) in streamId parameter - should not crash the server
      const res = await coreRequest
        .get(basePath + '/events')
        .set('Authorization', personalToken)
        .query({ streams: [':_system:username"'] });

      assert.strictEqual(res.status, 400, 'Status should be 400');
    });
  });

  describe('[AU02] audit events via events.get', () => {
    it('[RV4W] must return audit events with a valid :_audit:-prefixed id field', async () => {
      const res = await coreRequest
        .get(basePath + '/events')
        .set('Authorization', personalToken)
        .query({ streams: [':_audit:'] });

      const logs = res.body.events || [];
      assert.ok(logs.length > 0, 'Should have audit events');
      for (const log of logs) {
        assert.strictEqual(typeof log.id, 'string');
        assert.ok(log.id.startsWith(':_audit:'), 'audit event id should be prefixed with :_audit:');
      }
    });
  });
});
