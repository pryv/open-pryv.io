/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global assert */

const timestamp = require('unix-timestamp');
const helpers = require('../../../../test/helpers');
const { getVersions } = require('./util');
const { softwareVersion } = helpers;

describe('[MGNI] Migrations - new install', function () {
  const versions = getVersions();

  before(async () => {
    await versions.removeAll();
  });

  it('[OVYL] must set the initial version to the package file version and not perform other migrations', async () => {
    await versions.migrateIfNeeded();
    const v = await versions.getCurrent();
    assert.ok(v != null);
    assert.strictEqual(v._id, softwareVersion);
    assert.ok(Math.abs(v.initialInstall - timestamp.now()) <= 1000);
  });
});
