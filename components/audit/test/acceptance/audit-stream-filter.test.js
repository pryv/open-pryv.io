/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global assert, charlatan, cuid, initTests, initCore, coreRequest, getNewFixture, addAccessStreamIdPrefix */

// The audit stream filter is an authorization boundary: it is what keeps one
// access from reading another access's audit trail. It ran unfiltered on the
// PostgreSQL audit engine because the filter was read as a flat
// `{any,not}[]` while stores are handed the normalised nested shape, so no
// condition was built and the query returned every audit row of the user.
//
// These tests run against whichever audit engine is configured, so they cover
// both. `storages.audit.engine` defaults to sqlite regardless of the
// baseStorage engine, so the PostgreSQL path needs
// `storages__audit__engine=postgresql` to be exercised.
describe('[ASFL] audit stream filter', function () {
  this.timeout(60000);
  let fixtures, eventsPath, personal, appAccess, engine;

  before(async function () {
    await initTests();
    await initCore();
    engine = process.env.storages__audit__engine || 'sqlite (default)';
    fixtures = getNewFixture();
    const user = await fixtures.user(charlatan.Lorem.characters(7), { password: cuid() });
    await user.stream({ id: 'yo', name: 'YO' });
    personal = (await user.access({ type: 'personal', token: cuid() })).attrs;
    await user.session(personal.token);
    appAccess = (await user.access({
      type: 'app', token: cuid(), permissions: [{ streamId: 'yo', level: 'read' }]
    })).attrs;
    eventsPath = '/' + user.attrs.username + '/events';

    // Audit rows under BOTH accesses, so "everything" and "only mine" differ.
    for (let i = 0; i < 3; i++) {
      await coreRequest.get(eventsPath).set('Authorization', personal.token).query({ limit: 1 });
      await coreRequest.get(eventsPath).set('Authorization', appAccess.token).query({ limit: 1 });
    }
  });

  after(async function () {
    if (fixtures) await fixtures.clean();
  });

  async function auditQuery (token, streams) {
    const res = await coreRequest.get(eventsPath).set('Authorization', token).query({ streams });
    assert.strictEqual(res.status, 200);
    return res.body.events;
  }

  it('[ASFL1] an access asking for its own audit stream receives no other access rows', async function () {
    const events = await auditQuery(appAccess.token, [':_audit:access-' + appAccess.id]);
    const mine = addAccessStreamIdPrefix(appAccess.id);
    const theirs = addAccessStreamIdPrefix(personal.id);

    const leaked = events.filter((e) => e.streamIds.includes(theirs)).length;
    assert.strictEqual(leaked, 0,
      `[${engine}] DISCLOSURE: the app token received ${leaked} audit row(s) belonging ` +
      'to another access');
    assert.ok(events.length > 0, 'its own rows are still returned');
    assert.ok(events.every((e) => e.streamIds.includes(mine)),
      'every returned row carries the requested access stream');
  });

  it('[ASFL2] the personal access sees rows from both, so the filter is not simply empty', async function () {
    // Guards against "filter everything out" passing [ASFL1] for the wrong
    // reason: an unfiltered query must still be possible.
    const events = await auditQuery(personal.token, [':_audit:']);
    const mine = addAccessStreamIdPrefix(personal.id);
    const theirs = addAccessStreamIdPrefix(appAccess.id);
    assert.ok(events.some((e) => e.streamIds.includes(mine)), 'own rows present');
    assert.ok(events.some((e) => e.streamIds.includes(theirs)),
      'the other access rows are visible to the ACCOUNT OWNER, as intended');
  });

  it('[ASFL3] filtering by action returns only that action', async function () {
    const events = await auditQuery(personal.token, [':_audit:action-events.get']);
    assert.ok(events.length > 0, 'the action stream matched something');
    assert.ok(events.every((e) => e.streamIds.includes(':_audit:action-events.get')),
      'no row from another action came back');
  });

  it('[ASFL4] a stream id that is a suffix of a real one does not match it', async function () {
    // ' ' || stream_ids || ' ' anchoring: a LIKE built without it would let
    // 'ccess-<id>' match a row holding 'access-<id>'.
    const suffix = ('access-' + appAccess.id).slice(2);
    const events = await auditQuery(personal.token, [':_audit:' + suffix]);
    assert.strictEqual(events.length, 0,
      'a partial id must not match the full one it is a suffix of');
  });
});
