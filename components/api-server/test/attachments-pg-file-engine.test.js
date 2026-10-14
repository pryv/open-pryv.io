/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const async = require('async');
const fs = require('fs');

require('./test-helpers');
const helpers = require('./helpers');
const server = helpers.dependencies.instanceManager;
const testData = helpers.dynData({ prefix: 'pgfa' });

// End-to-end coverage for `storages.file.engine: postgresql` (attachments as
// chunked rows in the `attachment_files` table): the spawned api-server gets
// the engine via its settings while this process verifies through HTTP plus
// direct table queries — the in-process mall keeps the default filesystem
// engine, so it must not be used for assertions here.
describe('[PGFA] events attachments on PostgreSQL file storage', function () {
  before(function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
  });

  const user = structuredClone(testData.users[0]);
  const basePath = '/' + user.username + '/events';
  let request = null;
  let db = null;

  before(function (done) {
    const settings = structuredClone(helpers.dependencies.settings);
    settings.storages = settings.storages || {};
    settings.storages.file = { engine: 'postgresql' };
    async.series([
      testData.resetUsers,
      testData.resetAccesses,
      testData.resetStreams,
      server.ensureStarted.bind(server, settings),
      function (stepDone) {
        request = helpers.request(server.url);
        request.login(user, stepDone);
      }
    ], done);
  });

  before(function () {
    const { _internals } = require('../../../storages/engines/postgresql/src/_internals.ts');
    db = _internals.databasePG;
    assert.ok(db, 'PG engine databasePG internal must be set under the PG matrix');
  });

  after(async function () {
    if (db) await db.query('DELETE FROM attachment_files WHERE user_id = $1', [user.id]);
    await testData.cleanup();
  });

  // The upload runs once, in whichever test needs it first, so every test
  // also passes when selected on its own.
  let uploaded = null;
  function upload () {
    if (uploaded == null) {
      uploaded = new Promise((resolve) => {
        request.post(basePath)
          .field('event', JSON.stringify({ type: 'test/test', streamIds: [testData.streams[0].id] }))
          .attach('document', testData.attachments.document.path,
            testData.attachments.document.filename)
          .end(resolve);
      });
    }
    return uploaded;
  }

  async function uploadedEvent () {
    const res = await upload();
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    return res.body.event;
  }

  it('[PGFA1] must store uploaded attachments as rows and serve them back unchanged', async function () {
    const createdEvent = await uploadedEvent();
    assert.strictEqual(createdEvent.attachments.length, 1);
    const fileId = createdEvent.attachments[0].id;

    const rows = await db.query(
      'SELECT seq, OCTET_LENGTH(data) AS len FROM attachment_files WHERE user_id = $1 AND event_id = $2 AND file_id = $3 ORDER BY seq',
      [user.id, createdEvent.id, fileId]);
    assert.ok(rows.rows.length > 0, 'expected attachment rows in attachment_files');
    const storedSize = rows.rows.reduce((sum, r) => sum + Number(r.len), 0);
    assert.strictEqual(storedSize, testData.attachments.document.size);

    const readToken = createdEvent.attachments[0].readToken;
    const getRes = await new Promise((resolve) => {
      request.get(basePath + '/' + createdEvent.id + '/' + fileId + '?readToken=' + readToken)
        .buffer(true)
        .parse(binaryParser)
        .end(resolve);
    });
    assert.strictEqual(getRes.statusCode, 200);
    const original = fs.readFileSync(testData.attachments.document.path);
    assert.ok(original.equals(getRes.body), 'served bytes must equal the uploaded file');
  });

  it('[PGFA2] must delete the rows when the attachment is deleted', async function () {
    const createdEvent = await uploadedEvent();
    const fileId = createdEvent.attachments[0].id;
    const res = await new Promise((resolve) => {
      request.del(basePath + '/' + createdEvent.id + '/' + fileId).end(resolve);
    });
    assert.strictEqual(res.statusCode, 200);
    const rows = await db.query(
      'SELECT 1 FROM attachment_files WHERE user_id = $1 AND event_id = $2 AND file_id = $3',
      [user.id, createdEvent.id, fileId]);
    assert.strictEqual(rows.rows.length, 0, 'rows must be gone after attachment deletion');
  });

  function binaryParser (res, callback) {
    const chunks = [];
    res.on('data', (c) => chunks.push(Buffer.from(c)));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
  }
});
