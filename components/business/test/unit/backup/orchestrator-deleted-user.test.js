/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('assert');
const { BackupOrchestrator } = require('business/src/backup/BackupOrchestrator.ts');

// A backup runs in a process of its own, which does not hear of an account
// erasure: an account deleted after the run listed the users must not be
// backed up, since opening its stores would create its directory and empty
// databases again.
describe('[BKDU] backup of an account deleted during the run', function () {
  it('[BKDU1] backupAllUsers leaves out an account no longer in the index', async function () {
    const orch = Object.create(BackupOrchestrator.prototype);
    orch.logger = { info () {}, warn () {} };
    const indexed = new Map([['bkdu-kept-id', 'bkdukept']]); // 'bkdu-gone-id' deleted since the listing
    orch.usersLocalIndex = {
      getAllByUsername: async () => ({ bkdukept: 'bkdu-kept-id', bkdugone: 'bkdu-gone-id' }),
      getUsername: async (userId) => indexed.get(userId)
    };
    orch._getBackupConfig = async () => ({ engine: 'test' });
    orch._buildPerUserSince = () => ({});
    const opened = [];
    orch._backupSingleUser = async (writer, userId, username) => {
      opened.push(userId);
      return { userId, username, stats: {} };
    };
    orch._backupPlatform = async () => {};
    const writer = { manifest: null, writeManifest: async (m) => { writer.manifest = m; } };

    await orch.backupAllUsers(writer);

    assert.deepStrictEqual(opened, ['bkdu-kept-id'], 'the deleted account is not opened');
    assert.deepStrictEqual(writer.manifest.userManifests.map((m) => m.userId), ['bkdu-kept-id']);
  });
});
