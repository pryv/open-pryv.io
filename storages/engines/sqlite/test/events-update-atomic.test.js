/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * UserDatabase.updateEventAtomic reads, merges and writes an event in one
 * immediate transaction. Another connection holding the write lock (another
 * process serving the same user) makes it wait, then the merge sees what
 * that connection committed.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SQLite3 = require('better-sqlite3');
const { UserDatabase } = require('../src/userSQLite/UserDatabase.ts');
const eventsSchema = require('../src/userSQLite/schema/events.ts');
const { getLogger } = require('../../../test/helpers');

describe('[UEAT] SQLite UserDatabase.updateEventAtomic', function () {
  let tmp, db, other, release;

  beforeEach(async function () {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ueat-'));
    db = new UserDatabase(getLogger('ueat-test'), { dbPath: path.join(tmp, 'events.sqlite') });
    await db.init();
    await db.createEvent({ id: 'e1', streamIds: ['s1'], type: 'note/txt', content: 'original', time: 1, created: 1, createdBy: 'a', modified: 1, modifiedBy: 'a' });
    other = new SQLite3(path.join(tmp, 'events.sqlite'));
  });

  afterEach(function () {
    clearTimeout(release);
    if (other.inTransaction) other.exec('ROLLBACK');
    other.close();
    db.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('[UEA1] waits for a lock held by another connection, then merges onto what it committed', async function () {
    other.exec('BEGIN IMMEDIATE');
    const row = eventsSchema.toDB({ content: 'committed by the other connection' });
    other.prepare('UPDATE events SET content = @content WHERE eventid = \'e1\'').run({ content: row.content });
    release = setTimeout(() => other.exec('COMMIT'), 100);
    let seen;
    const written = await db.updateEventAtomic('e1', (stored) => {
      seen = stored.content;
      return { next: { ...stored, description: 'merged' } };
    });
    assert.strictEqual(seen, 'committed by the other connection');
    assert.strictEqual(written.description, 'merged');
    const back = db.getOneEvent('e1');
    assert.strictEqual(back.content, 'committed by the other connection');
    assert.strictEqual(back.description, 'merged');
  });

  it('[UEA2] null from the merge writes nothing; an unknown event gives false', async function () {
    assert.strictEqual(await db.updateEventAtomic('e1', () => null), null);
    assert.strictEqual(db.getOneEvent('e1').content, 'original');
    assert.strictEqual(await db.updateEventAtomic('missing', () => { throw new Error('not called'); }), false);
  });

  it('[UEA3] a history item is written in the same transaction', async function () {
    await db.updateEventAtomic('e1', (stored) => ({
      next: { ...stored, content: 'second' },
      versionItem: { ...stored, id: 'v1', headId: 'e1' }
    }));
    const history = db.getEventHistory('e1');
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].content, 'original');
    assert.strictEqual(db.getOneEvent('e1').content, 'second');
  });
});
