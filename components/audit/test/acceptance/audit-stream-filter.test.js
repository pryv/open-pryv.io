/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global assert, charlatan, cuid, initTests, initCore, coreRequest, getNewFixture, addAccessStreamIdPrefix */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { pollUntil } = require('test-helpers');

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
  let otherEventsPath, otherPersonal;

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

    // A SECOND user. The filter is also what keeps one user's audit trail out
    // of another's: the query is AND-ed with `user_id`, and a malformed
    // disjunction can drop that predicate.
    const other = await fixtures.user(charlatan.Lorem.characters(7), { password: cuid() });
    otherPersonal = (await other.access({ type: 'personal', token: cuid() })).attrs;
    await other.session(otherPersonal.token);
    otherEventsPath = '/' + other.attrs.username + '/events';

    // Audit rows under BOTH accesses, so "everything" and "only mine" differ.
    for (let i = 0; i < 3; i++) {
      await coreRequest.get(eventsPath).set('Authorization', personal.token).query({ limit: 1 });
      await coreRequest.get(eventsPath).set('Authorization', appAccess.token).query({ limit: 1 });
      await coreRequest.get(otherEventsPath).set('Authorization', otherPersonal.token).query({ limit: 1 });
    }
    // Those rows are written after each response is sent. Wait until rows of
    // all three accesses exist: a leak check run before the other user's rows
    // land would pass for the wrong reason.
    // (Matched on the seeded calls' `limit`, as these polling reads are audited too.)
    const hasRowsOf = (...accessIds) => (events) => accessIds.every(
      (id) => events.some((e) => e.content?.query?.limit === '1' &&
        e.streamIds.includes(addAccessStreamIdPrefix(id))));
    await pollUntil(() => auditQuery(personal.token, [':_audit:']), hasRowsOf(personal.id, appAccess.id));
    await pollUntil(() => auditQuery(otherPersonal.token, [':_audit:'], otherEventsPath), hasRowsOf(otherPersonal.id));
  });

  after(async function () {
    if (fixtures) await fixtures.clean();
  });

  async function auditQuery (token, streams, path = eventsPath) {
    // A logical (multi-block) query has to travel as a JSON string; the
    // bracket-serialised form is rejected as an invalid `streams` parameter.
    const value = streams.some((s) => typeof s === 'object') ? JSON.stringify(streams) : streams;
    const res = await coreRequest.get(path).set('Authorization', token).query({ streams: value });
    assert.strictEqual(res.status, 200,
      'query rejected: ' + JSON.stringify(res.body && res.body.error));
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

  it('[ASFL5] a MULTI-BLOCK query never reaches another user\'s rows', async function () {
    // Two stream filters become an OR of blocks. AND binds tighter than OR, so
    // a disjunction that is not parenthesised as a whole leaves the second
    // branch with no user_id predicate — matching every user's audit rows.
    // Two query OBJECTS, not two ids in one `any`: a plain `streams: [a, b]`
    // is a single OR-block and would never exercise the disjunction.
    // Names a shared action stream, which needs no knowledge of the other user.
    const events = await auditQuery(personal.token, [
      { any: [':_audit:access-' + appAccess.id] },
      { any: [':_audit:action-events.get'] }
    ]);
    const foreign = addAccessStreamIdPrefix(otherPersonal.id);
    const leaked = events.filter((e) => e.streamIds.includes(foreign)).length;
    assert.strictEqual(leaked, 0,
      `[${engine}] CROSS-USER DISCLOSURE: ${leaked} row(s) from another user came back`);
  });

  it('[ASFL6] a match-all block alongside a constrained one does not break the query', async function () {
    // The match-all exit returns "no filter"; values bound by the earlier block
    // must be rewound or the placeholders misalign and the request never
    // returns (PG: "bind message supplies N parameters, but ... requires M").
    const events = await auditQuery(personal.token, [
      { any: [':_audit:access-' + appAccess.id] },
      { any: [':_audit:'] }
    ]);
    assert.ok(Array.isArray(events), 'the request completed instead of hanging');
    const foreign = addAccessStreamIdPrefix(otherPersonal.id);
    assert.strictEqual(events.filter((e) => e.streamIds.includes(foreign)).length, 0,
      'still no other user rows');
  });

  it('[ASFL7] a LIKE wildcard in a stream id matches nothing, not everything', async function () {
    // '%' and '_' are wildcards; unescaped, 'access-%' would return every
    // access's rows.
    const events = await auditQuery(personal.token, [':_audit:access-%']);
    assert.strictEqual(events.length, 0,
      `[${engine}] a wildcard id must be matched literally, not expanded`);
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
