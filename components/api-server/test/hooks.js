/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
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
    const previewsDirPath = config.get('storages:engines:filesystem:previewsDirPath');

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
