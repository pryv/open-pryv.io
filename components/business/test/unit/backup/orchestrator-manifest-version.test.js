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
const { getAPIVersion } = require('middleware/src/project_version.ts');

// The manifest's coreVersion used to be read from the `storage` component's
// package.json, which is frozen at a v1 number: every v2 backup claimed to come
// from core 1.9.3. It must report the same version as service/info.
describe('[BKVR] backup manifest coreVersion', function () {
  function stubbedOrchestrator () {
    const orch = Object.create(BackupOrchestrator.prototype);
    orch.logger = { info () {}, warn () {} };
    orch.usersLocalIndex = {
      getAllByUsername: async () => ({ bkvruser: 'bkvr-user-id' }),
      getUsername: async () => 'bkvruser'
    };
    orch._getBackupConfig = async () => ({ engine: 'test' });
    orch._buildPerUserSince = () => ({});
    orch._backupSingleUser = async (writer, userId, username) => ({ userId, username, stats: {} });
    orch._backupPlatform = async () => {};
    return orch;
  }

  function capturingWriter () {
    const writer = { manifest: null };
    writer.writeManifest = async (m) => { writer.manifest = m; };
    return writer;
  }

  it('[BKVR-01] backupAllUsers writes the API version, not the storage package version', async function () {
    const writer = capturingWriter();
    await stubbedOrchestrator().backupAllUsers(writer);
    assert.strictEqual(writer.manifest.coreVersion, await getAPIVersion());
    assert.notStrictEqual(writer.manifest.coreVersion, require('storage/package.json').version);
  });

  it('[BKVR-02] backupUser writes the API version, not the storage package version', async function () {
    const writer = capturingWriter();
    await stubbedOrchestrator().backupUser('bkvr-user-id', writer);
    assert.strictEqual(writer.manifest.coreVersion, await getAPIVersion());
    assert.notStrictEqual(writer.manifest.coreVersion, require('storage/package.json').version);
  });
});
