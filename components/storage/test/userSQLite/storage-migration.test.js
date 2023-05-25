/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

/* global assert */

const setUserBasePathTestOnly = require('storage').userLocalDirectory.setBasePathTestOnly;

const path = require('path');
const { copy, pathExists } = require('fs-extra');
const cuid = require('cuid');
const versioning = require('../../src/userSQLite/versioning');
const UserDatabase = require('../../src/userSQLite/UserDatabase');
const os = require('os');
const { getLogger } = require('@pryv/boiler');
const Storage = require('../../src/userSQLite/Storage');

describe('UserCentric Storage Migration', () => {
  let logger;
  before(async () => {
    logger = getLogger('sqlite-storage-migration-test');
  });

  after(() => {
    // reset userDirectory base path to original
    setUserBasePathTestOnly();
  });

  it('[MFFR] a single Migrate v0 to v1', async function () {
    const userid = cuid();
    const srcPath = path.join(__dirname, './support/migration/audit-v0.sqlite');
    const v0dbPath = path.join(os.tmpdir(), userid + '-v0.sqlite');
    const v1dbPath = path.join(os.tmpdir(), userid + '-v1.sqlite');
    await copy(srcPath, v0dbPath);

    const v1user = new UserDatabase(logger, { dbPath: v1dbPath });
    await v1user.init();

    const resMigrate = await versioning.migrate0to1(v0dbPath, v1user, logger);
    assert.equal(resMigrate.count, 298);
  });

  it('[RXVF] check userDir and perform migration when needed', async function () {
    this.timeout(30000);
    const srcDir = path.join(__dirname, './support/migration-userDirV0');
    const tempUserDir = path.join(os.tmpdir(), 'pryv.io-test-userdir-' + Math.random().toString(36).substring(2, 8));
    await copy(srcDir, tempUserDir);
    assert.isFalse(await pathExists(path.join(tempUserDir, 'audit-db-version-1.0.0.txt')));
    setUserBasePathTestOnly(tempUserDir);
    const storage = new Storage('audit');
    await storage.init();
    assert.isTrue(await pathExists(path.join(tempUserDir, 'audit-db-version-1.0.0.txt')));
    storage.close();
  });
});
