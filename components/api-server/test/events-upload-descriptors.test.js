/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid, app */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Attachments come from multipart uploads on the REST routes only. The upload
// descriptors (temp path, size, digest) are produced by the server's upload
// parser and handed to the method on its context; method params never carry
// them, whatever the entry point (REST, batch, socket.io).
describe('[EUPD] events upload descriptors', function () {
  this.timeout(60_000);

  let fixtures, username, token, streamId;
  let sentinelDir, sentinelPath;
  const sentinelContent = 'eupd-sentinel-' + cuid();

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = 'eupd-' + cuid().slice(-8);
    token = cuid();
    streamId = 'eupd-files';
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    await user.stream({ id: streamId, name: streamId });

    sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eupd-'));
    sentinelPath = path.join(sentinelDir, 'sentinel.txt');
    fs.writeFileSync(sentinelPath, sentinelContent);
  });

  after(async function () {
    if (sentinelDir != null) fs.rmSync(sentinelDir, { recursive: true, force: true });
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  function descriptor (filePath) {
    return {
      fieldname: 'file',
      originalname: 'sentinel.txt',
      mimetype: 'text/plain',
      path: filePath,
      size: sentinelContent.length,
      integrity: 'sha256-' + crypto.createHash('sha256').update(sentinelContent).digest('base64')
    };
  }

  async function batch (calls) {
    const res = await coreRequest
      .post('/' + username)
      .set('Authorization', token)
      .send(calls);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.results;
  }

  async function eventsInStream (sId) {
    const res = await coreRequest
      .get('/' + username + '/events')
      .set('Authorization', token)
      .query({ streams: JSON.stringify([sId]), state: 'all' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.events;
  }

  async function newStream () {
    const id = 'eupd-' + cuid().slice(-10);
    const res = await coreRequest
      .post('/' + username + '/streams')
      .set('Authorization', token)
      .send({ id, name: id });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return id;
  }

  async function download (eventId, fileId) {
    const res = await coreRequest
      .get('/' + username + '/events/' + eventId + '/' + fileId)
      .set('Authorization', token)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    assert.strictEqual(res.status, 200);
    return res.body;
  }

  function sha256Integrity (buf) {
    return 'sha256-' + crypto.createHash('sha256').update(buf).digest('base64');
  }

  it('[EUPD1] a batch events.create cannot carry upload descriptors', async function () {
    const sId = await newStream();
    const results = await batch([{
      method: 'events.create',
      params: { streamIds: [sId], type: 'note/txt', content: 'eupd1', files: [descriptor(sentinelPath)] }
    }]);
    assert.strictEqual(results.length, 1);
    assert.ok(results[0].error != null, 'expected an error, got ' + JSON.stringify(results[0]));
    assert.strictEqual(results[0].error.id, 'invalid-parameters-format');
    assert.strictEqual(results[0].event, undefined);
    const events = await eventsInStream(sId);
    assert.strictEqual(events.length, 0, 'no event may be created: ' + JSON.stringify(events));
  });

  it('[EUPD2] a batch events.update cannot carry upload descriptors', async function () {
    const sId = await newStream();
    const created = await batch([{
      method: 'events.create',
      params: { streamIds: [sId], type: 'note/txt', content: 'eupd2' }
    }]);
    assert.ok(created[0].event, JSON.stringify(created[0]));
    const eventId = created[0].event.id;

    const results = await batch([{
      method: 'events.update',
      params: { id: eventId, update: { description: 'eupd2-updated' }, files: [descriptor(sentinelPath)] }
    }]);
    assert.ok(results[0].error != null, 'expected an error, got ' + JSON.stringify(results[0]));
    assert.strictEqual(results[0].error.id, 'invalid-parameters-format');

    const res = await coreRequest
      .get('/' + username + '/events/' + eventId)
      .set('Authorization', token);
    assert.strictEqual(res.status, 200);
    const attachments = res.body.event.attachments || [];
    assert.strictEqual(attachments.length, 0, 'no attachment may be stored: ' + JSON.stringify(attachments));
    assert.notStrictEqual(res.body.event.description, 'eupd2-updated', 'the update must not be applied');
  });

  it('[EUPD3] a REST multipart create stores the uploaded bytes', async function () {
    const content = Buffer.from('eupd3-upload-' + cuid());
    const created = await coreRequest
      .post('/' + username + '/events')
      .set('Authorization', token)
      .field('event', JSON.stringify({ streamIds: [streamId], type: 'file/attached' }))
      .attach('file', content, { filename: 'eupd3.txt', contentType: 'text/plain' });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const att = created.body.event.attachments;
    assert.strictEqual(att.length, 1);
    assert.strictEqual(att[0].fileName, 'eupd3.txt');
    assert.strictEqual(att[0].size, content.length);
    if (att[0].integrity != null) assert.strictEqual(att[0].integrity, sha256Integrity(content));
    const served = await download(created.body.event.id, att[0].id);
    assert.ok(served.equals(content), 'served bytes must match the upload');
  });

  it('[EUPD4] a REST multipart update adds the uploaded bytes', async function () {
    const created = await coreRequest
      .post('/' + username + '/events')
      .set('Authorization', token)
      .send({ streamIds: [streamId], type: 'note/txt', content: 'eupd4' });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const eventId = created.body.event.id;

    const content = Buffer.from('eupd4-upload-' + cuid());
    const updated = await coreRequest
      .post('/' + username + '/events/' + eventId)
      .set('Authorization', token)
      .attach('file', content, { filename: 'eupd4.txt', contentType: 'text/plain' });
    assert.strictEqual(updated.status, 200, JSON.stringify(updated.body));
    const att = updated.body.event.attachments;
    assert.strictEqual(att.length, 1);
    assert.strictEqual(att[0].size, content.length);
    if (att[0].integrity != null) assert.strictEqual(att[0].integrity, sha256Integrity(content));
    const served = await download(eventId, att[0].id);
    assert.ok(served.equals(content), 'served bytes must match the upload');
  });

  it('[EUPD5] a REST JSON body cannot carry upload descriptors', async function () {
    const sId = await newStream();
    const res = await coreRequest
      .post('/' + username + '/events')
      .set('Authorization', token)
      .send({ streamIds: [sId], type: 'note/txt', content: 'eupd5', files: [descriptor(sentinelPath)] });
    // The REST route ignores a `files` key in the body: the event is created
    // without any attachment.
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual((res.body.event.attachments || []).length, 0);
  });

  describe('[EUPC] upload descriptors on the method context', function () {
    let storageLayer, MethodContext;

    before(async function () {
      storageLayer = await require('storage').getStorageLayer();
      MethodContext = require('business').MethodContext;
    });

    async function callWithUploads (methodId, params, uploadedFiles) {
      const context = new MethodContext({ name: 'test', ip: '127.0.0.1' }, username, token, null, {}, {}, null);
      await context.init();
      await context.retrieveExpandedAccess(storageLayer);
      context.methodId = methodId;
      context.uploadedFiles = uploadedFiles;
      return await new Promise((resolve) => {
        app.api.call(context, params, (err, result) => resolve({ err, result }));
      });
    }

    it('[EUPC1] events.create refuses an upload descriptor outside the upload directory', async function () {
      const sId = await newStream();
      const { err, result } = await callWithUploads('events.create',
        { streamIds: [sId], type: 'note/txt', content: 'eupc1' }, [descriptor(sentinelPath)]);
      assert.ok(err != null, 'expected a refusal, got ' + JSON.stringify(result && result.event));
      assert.strictEqual(err.id, 'invalid-parameters-format');
      const events = await eventsInStream(sId);
      assert.strictEqual(events.length, 0, 'no event may be created: ' + JSON.stringify(events));
    });

    it('[EUPC2] events.update refuses an upload descriptor outside the upload directory', async function () {
      const sId = await newStream();
      const created = await batch([{
        method: 'events.create',
        params: { streamIds: [sId], type: 'note/txt', content: 'eupc2' }
      }]);
      const eventId = created[0].event.id;
      const { err } = await callWithUploads('events.update',
        { id: eventId, update: {} }, [descriptor(sentinelPath)]);
      assert.ok(err != null, 'expected a refusal');
      assert.strictEqual(err.id, 'invalid-parameters-format');
      const res = await coreRequest
        .get('/' + username + '/events/' + eventId)
        .set('Authorization', token);
      assert.strictEqual((res.body.event.attachments || []).length, 0);
    });
  });
});
