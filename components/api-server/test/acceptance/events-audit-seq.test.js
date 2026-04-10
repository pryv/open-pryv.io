/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Audit logs tests (Pattern C)
 * Run with: PATTERN_C_AUDIT=1 npx mocha --no-config --require test/helpers-c.js test/acceptance/events-audit.test.js
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid, charlatan */

const { getConfig } = require('@pryv/boiler');

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
    const { getUsersRepository } = require('business/src/users');
    const usersRepository = await getUsersRepository();
    await usersRepository.deleteAll();
    if (savedIntegrityCheck != null) {
      process.env.DISABLE_INTEGRITY_CHECK = savedIntegrityCheck;
    } else {
      delete process.env.DISABLE_INTEGRITY_CHECK;
    }
  });

  describe('[AU01] GET /events', () => {
    it('[0BK7] must not return null values or trashed=false', async () => {
      const res = await coreRequest
        .get(basePath + '/events')
        .set('Authorization', personalToken)
        .query({ streams: [':_audit:action-events.get'] });

      const events = res.body.events;
      assert.ok(events[0], 'Should have at least one audit event');
      const event = events[0];

      for (const [key, val] of Object.entries(event)) {
        assert.ok(val !== null, `Property ${key} should not be null`);
      }
      if (event.trashed != null && event.trashed === false) {
        assert.fail('trashed=false should not be present');
      }
    });

    it('[VBV0] must not return "auth" in "content:query"', async () => {
      // Make a request with auth in query
      await coreRequest
        .get(basePath + '/events')
        .query({ auth: actionsToken });

      const res = await coreRequest
        .get(basePath + '/events')
        .set('Authorization', personalToken)
        .query({ streams: [':_audit:action-events.get'] });

      const event = res.body.events[0];
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

  describe('[AU02] GET /audit/logs', () => {
    it('[RV4W] must return a valid id field', async () => {
      const res = await coreRequest
        .get(basePath + '/audit/logs')
        .set('Authorization', personalToken);

      const logs = res.body.auditLogs || [];
      assert.ok(logs.length > 0, 'Should have audit logs');
      for (const log of logs) {
        assert.notStrictEqual(log.id.substring(':_audit:'.length), 'undefined');
      }
    });
  });
});
