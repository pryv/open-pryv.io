/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * EventFiles conformance test suite.
 * @param {Function} getEventFiles - async function returning an initialized EventFiles instance
 * @param {Function} cleanupFn - async function for cleanup (receives userId)
 */
module.exports = function conformanceTests (getEventFiles, cleanupFn) {
  const assert = require('node:assert');
  const cuid = require('cuid');
  const { Readable } = require('stream');

  describe('EventFiles conformance', () => {
    let ef;
    const userId = cuid();
    const eventId = cuid();

    before(async () => {
      ef = await getEventFiles();
    });

    after(async () => {
      if (cleanupFn) await cleanupFn(userId);
    });

    describe('saveAttachmentFromStream() / getAttachmentStream()', () => {
      it('must save and retrieve an attachment', async () => {
        const content = 'hello-attachment-' + cuid();
        const stream = Readable.from([Buffer.from(content)]);
        const fileId = await ef.saveAttachmentFromStream(stream, userId, eventId);
        assert.ok(fileId != null);

        const readStream = await ef.getAttachmentStream(userId, eventId, fileId);
        const chunks = [];
        for await (const chunk of readStream) {
          chunks.push(chunk);
        }
        const result = Buffer.concat(chunks).toString();
        assert.strictEqual(result, content);
      });
    });

    describe('removeAttachment()', () => {
      it('must remove a single attachment', async () => {
        const stream = Readable.from([Buffer.from('to-remove')]);
        const fileId = await ef.saveAttachmentFromStream(stream, userId, eventId);
        await ef.removeAttachment(userId, eventId, fileId);

        try {
          await ef.getAttachmentStream(userId, eventId, fileId);
          assert.fail('should throw for removed attachment');
        } catch (e) {
          assert.ok(e);
        }
      });
    });

    describe('removeAllForEvent()', () => {
      it('must remove all attachments for an event', async () => {
        const evId = cuid();
        const stream1 = Readable.from([Buffer.from('file1')]);
        const stream2 = Readable.from([Buffer.from('file2')]);
        const fId1 = await ef.saveAttachmentFromStream(stream1, userId, evId);
        await ef.saveAttachmentFromStream(stream2, userId, evId);

        await ef.removeAllForEvent(userId, evId);

        try {
          await ef.getAttachmentStream(userId, evId, fId1);
          assert.fail('should throw after removeAllForEvent');
        } catch (e) {
          assert.ok(e);
        }
      });
    });

    describe('getFileStorageInfos()', () => {
      it('must return a number', async () => {
        const size = await ef.getFileStorageInfos(userId);
        assert.strictEqual(typeof size, 'number');
      });
    });

    describe('removeAllForUser()', () => {
      it('must remove all files for a user', async () => {
        const uId = cuid();
        const evId = cuid();
        const stream = Readable.from([Buffer.from('user-file')]);
        await ef.saveAttachmentFromStream(stream, uId, evId);
        await ef.removeAllForUser(uId);

        const size = await ef.getFileStorageInfos(uId);
        assert.strictEqual(size, 0);
      });
    });
  });
};
