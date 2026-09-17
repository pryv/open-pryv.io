/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global assert, cuid, audit, initTests */

// An audit record must be identifiable. Without an id it cannot be read back by
// getOneEvent, updated, or chained into a history — so a stored null-id row is a
// broken record, not a lenient one.
//
// The audited API path assigns an id in buildDefaultEvent, but a caller handing
// eventForUser a hand-built event may not, and the engines used to disagree
// there: PostgreSQL rejected the write with a NOT NULL violation while SQLite
// stored the null. This pins the agreement, on whichever engine is configured.
describe('[AEID] an audit event written without an id', function () {
  const userId = 'aeid-' + cuid();
  const createdBy = 'aeid-' + cuid();
  let userStorage;

  before(async function () {
    await initTests();
    userStorage = await audit.storage.forUser(userId);
  });

  it('[AEID1] is accepted and comes back with one, on either engine', async function () {
    const engine = process.env.storages__audit__engine || 'sqlite (default)';
    // No `id`: exactly what the direct-call path can produce.
    await audit.eventForUser(userId, {
      type: 'log/test',
      createdBy,
      streamIds: [':_audit:test'],
      content: { action: 'events.get', message: 'no id supplied' }
    });

    const entries = await userStorage.getEvents({
      query: [{ type: 'equal', content: { field: 'createdBy', value: createdBy } }]
    });
    assert.strictEqual(entries.length, 1, `[${engine}] the event was written`);
    const id = entries[0].id;
    assert.ok(id != null && id !== '',
      `[${engine}] the stored record must carry an id, not null — a null-id audit row ` +
      'cannot be fetched, updated or chained');
  });

  it('[AEID2] an id supplied by the caller is preserved, not overwritten', async function () {
    const ownId = 'aeid-own-' + cuid();
    const marker = 'aeid-marker-' + cuid();
    await audit.eventForUser(userId, {
      id: ownId,
      type: 'log/test',
      createdBy: marker,
      streamIds: [':_audit:test'],
      content: { action: 'events.get', message: 'caller supplied an id' }
    });

    const entries = await userStorage.getEvents({
      query: [{ type: 'equal', content: { field: 'createdBy', value: marker } }]
    });
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].id, ownId, 'the caller\'s id must survive');
  });
});
