/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
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
const fs = require('fs');
const { getConfig } = require('@pryv/boiler');
const util = require('util');

let usersIndex, platform;

async function initIndexPlatform () {
  if (usersIndex != null) return;
  const { getUsersLocalIndex } = require('storage');
  usersIndex = await getUsersLocalIndex();
  platform = require('platform').platform;
  await platform.init();
}

exports.mochaHooks = {
  async beforeAll () {
    const config = await getConfig();

    // create preview directories that would normally be created in normal setup
    const previewsDirPath = config.get('eventFiles:previewsDirPath');

    if (!fs.existsSync(previewsDirPath)) {
      fs.mkdirSync(previewsDirPath, { recursive: true });
    }
  },
  async beforeEach () {
    await checkIndexAndPlatformIntegrity('BEFORE ' + this.currentTest.title);
  },
  async afterEach () {
    await checkIndexAndPlatformIntegrity('AFTER ' + this.currentTest.title);
  }
};

async function checkIndexAndPlatformIntegrity (title) {
  await initIndexPlatform();
  const checks = [
    await platform.checkIntegrity(),
    await usersIndex.checkIntegrity()
  ];
  for (const check of checks) {
    if (check.errors.length > 0) {
      const checkStr = util.inspect(checks, false, null, true);
      throw new Error(`${title} => Check should be empty \n${checkStr}`);
    }
  }
}
