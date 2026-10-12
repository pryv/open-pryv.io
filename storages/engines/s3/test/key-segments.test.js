/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const { Readable } = require('node:stream');

// No S3 store needed: the ids are checked before any request is sent, and the
// client below records every command it is handed.
describe('[S3KS] S3 attachment keys from ids', function () {
  let files, sent;

  beforeEach(function () {
    const { EventS3Files } = require('../src/EventS3Files.ts');
    files = new EventS3Files();
    files.bucket = 'test-bucket';
    files.keyPrefix = 'prefix/';
    sent = [];
    files.client = {
      async send (command) {
        sent.push(command);
        return { Contents: [], IsTruncated: false };
      }
    };
  });

  const badIds = ['', '.', '..', 'evt/other', '../evt', 'evt/'];

  it('[S3KS1] an event id that is not a single key segment is refused before any request', async function () {
    for (const eventId of badIds) {
      await assert.rejects(() => files.removeAllForEvent('user1', eventId), /Invalid attachment key segment/, JSON.stringify(eventId));
      await assert.rejects(() => files.removeAttachment('user1', eventId, 'file1'), /Invalid attachment key segment/, JSON.stringify(eventId));
      await assert.rejects(() => files.getAttachmentStream('user1', eventId, 'file1'), /Invalid attachment key segment/, JSON.stringify(eventId));
      await assert.rejects(() => files.saveAttachmentFromStream(Readable.from(['x']), 'user1', eventId, 'file1'), /Invalid attachment key segment/, JSON.stringify(eventId));
    }
    assert.deepStrictEqual(sent, []);
  });

  it('[S3KS2] a user id or a file id that is not a single key segment is refused before any request', async function () {
    for (const id of badIds) {
      await assert.rejects(() => files.removeAllForUser(id), /Invalid attachment key segment/, JSON.stringify(id));
      await assert.rejects(() => files.getFileStorageInfos(id), /Invalid attachment key segment/, JSON.stringify(id));
      await assert.rejects(() => files.removeAttachment('user1', 'evt1', id), /Invalid attachment key segment/, JSON.stringify(id));
    }
    assert.deepStrictEqual(sent, []);
  });

  it('[S3KS3] single-segment ids build the documented key', async function () {
    await files.removeAttachment('user1', 'evt1', 'file1');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].input.Key, 'prefix/user1/evt1/file1');
    await files.removeAllForEvent('user1', 'evt1');
    assert.strictEqual(sent[1].input.Prefix, 'prefix/user1/evt1/');
  });
});
