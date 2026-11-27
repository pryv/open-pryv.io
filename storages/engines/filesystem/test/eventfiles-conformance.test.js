/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const conformanceTests = require('storages/interfaces/fileStorage/conformance/EventFiles.test').default;

const noopLogger = { debug () {}, info () {}, warn () {}, error () {} };

describe('[FSEF] filesystem EventFiles conformance', () => {
  let ef;
  let baseDir;
  let userLocalDirectory;

  before(() => {
    // The user directories live in a temporary folder: no configured path,
    // nothing left in the workspace's data folders.
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-fsef-'));
    userLocalDirectory = require('storage/src/userLocalDirectory.ts');
    userLocalDirectory.setBasePathTestOnly(baseDir);
    const { _internals } = require('../src/_internals.ts');
    _internals.set('config', {});
    _internals.set('getLogger', () => noopLogger);
    _internals.set('userLocalDirectory', userLocalDirectory);
  });

  after(() => {
    if (baseDir != null) fs.rmSync(baseDir, { recursive: true, force: true });
  });

  conformanceTests(async () => {
    const { EventFiles } = require('../src/EventLocalFiles.ts');
    ef = new EventFiles();
    await ef.init();
    return ef;
  }, async (userId) => {
    if (ef) await ef.removeAllForUser(userId);
  });

  describe('path segments', () => {
    it('[FSEF1] must refuse an event or file id that leaves its directory', async () => {
      const userId = 'fsef-user-1';
      for (const [eventId, fileId] of [['../escape', undefined], ['event-1', '../escape'], ['event-1', '..']]) {
        await assert.rejects(
          ef.saveAttachmentFromStream(Readable.from([Buffer.from('x')]), userId, eventId, fileId),
          /Invalid attachment path segment/,
          `ids ${eventId} / ${fileId} must be refused`);
      }
      const escaped = path.join(baseDir, 'escape');
      assert.ok(!fs.existsSync(escaped), 'nothing written outside the user directory');
    });

    it('[FSEF2] must count the size of the files saved for a user', async () => {
      const userId = 'fsef-user-2';
      await ef.saveAttachmentFromStream(Readable.from([Buffer.from('12345')]), userId, 'event-1');
      await ef.saveAttachmentFromStream(Readable.from([Buffer.from('123')]), userId, 'event-2');
      assert.strictEqual(await ef.getFileStorageInfos(userId), 8);
      await ef.removeAllForUser(userId);
      assert.strictEqual(await ef.getFileStorageInfos(userId), 0);
    });
  });
});
