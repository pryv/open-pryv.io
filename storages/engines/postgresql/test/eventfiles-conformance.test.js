/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const helpers = require('../../../test/helpers');
const { EventPGFiles } = require('../src/EventPGFiles.ts');
const { _internals } = require('../src/_internals.ts');
const conformanceTests = require('storages/interfaces/fileStorage/conformance/EventFiles.test').default;

describe('[PGEF] PostgreSQL EventFiles conformance', function () {
  before(function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
  });

  let ef;

  conformanceTests(
    async () => {
      await helpers.dependencies.init();
      if (!_internals.getLogger) {
        _internals.set('getLogger', helpers.getLogger);
      }
      _internals.set('config', helpers.state.config);
      ef = new EventPGFiles();
      await ef.init();
      return ef;
    },
    async (userId) => {
      if (ef) {
        await ef.db.query('DELETE FROM attachment_files WHERE user_id = $1', [userId]);
      }
    }
  );

  describe('chunked storage (PG-specific)', function () {
    const assert = require('node:assert');
    const { createId: cuid } = require('@paralleldrive/cuid2');
    const { Readable } = require('stream');
    const userId = 'pgef-chunk-' + cuid();

    after(async () => {
      if (ef) {
        await ef.db.query('DELETE FROM attachment_files WHERE user_id = $1', [userId]);
      }
    });

    it('[PGEF1] must round-trip a file larger than one chunk, split across rows', async () => {
      const eventId = cuid();
      // 2.5 MiB of non-repeating bytes, streamed in odd-sized pieces so
      // chunk boundaries never align with incoming buffer boundaries
      const content = Buffer.alloc(Math.floor(2.5 * 1024 * 1024));
      for (let i = 0; i < content.length; i += 4) content.writeUInt32LE(i, i);
      const pieces = [];
      for (let off = 0; off < content.length; off += 100_000 + 1) {
        pieces.push(content.subarray(off, off + 100_000 + 1));
      }
      const fileId = await ef.saveAttachmentFromStream(Readable.from(pieces), userId, eventId);

      const rows = await ef.db.query(
        'SELECT seq, OCTET_LENGTH(data) AS len FROM attachment_files WHERE user_id = $1 AND event_id = $2 AND file_id = $3 ORDER BY seq',
        [userId, eventId, fileId]);
      assert.strictEqual(rows.rows.length, 3, 'expected 2 full chunks + remainder');
      assert.strictEqual(Number(rows.rows[0].len), 1024 * 1024);
      assert.strictEqual(Number(rows.rows[1].len), 1024 * 1024);

      const readStream = await ef.getAttachmentStream(userId, eventId, fileId);
      const chunks = [];
      for await (const chunk of readStream) chunks.push(chunk);
      assert.ok(content.equals(Buffer.concat(chunks)), 'read-back must be byte-identical');
      assert.strictEqual(await ef.getFileStorageInfos(userId), content.length);
    });

    it('[PGEF2] must store a zero-byte attachment as an existing, empty file', async () => {
      const eventId = cuid();
      const fileId = await ef.saveAttachmentFromStream(Readable.from([]), userId, eventId);
      const readStream = await ef.getAttachmentStream(userId, eventId, fileId);
      const chunks = [];
      for await (const chunk of readStream) chunks.push(chunk);
      assert.strictEqual(Buffer.concat(chunks).length, 0);
    });
  });
});
