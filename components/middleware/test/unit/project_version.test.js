/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const path = require('path');
const assert = require('node:assert');
const { execSync } = require('child_process');
const fs = require('fs');
const { getAPIVersion } = require('../../src/project_version');

const versionFilePath = path.join(__dirname, '../../../../', '.api-version');

describe('[APIV] APIVersion#version', () => {
  let originalVersion;
  before(() => {
    originalVersion = fs.existsSync(versionFilePath)
      ? fs.readFileSync(versionFilePath, { encoding: 'utf-8' })
      : null;
  });
  after(() => {
    if (originalVersion != null) {
      fs.writeFileSync(versionFilePath, originalVersion, { encoding: 'utf-8' });
    } else {
      fs.rmSync(versionFilePath, { force: true });
    }
  });

  describe('[AV01] when a ".api-version" file exists in the project and is !== that 1.2.3', () => {
    before(() => {
      fs.writeFileSync(versionFilePath, '1.2.4', { encoding: 'utf-8' });
    });
    it('[5ICP] reads .api-version and returns that constant', async () => {
      const version = await getAPIVersion(true);
      assert.strictEqual(version, '1.2.4');
    });
  });

  describe('[AV02] when a ".api-version" file exists in the project and is 1.2.3 (sentinel)', () => {
    before(() => {
      fs.writeFileSync(versionFilePath, '1.2.3', { encoding: 'utf-8' });
    });
    it('[HV40] should return git tag version', async function () {
      if (process.env.IS_CI === 'true') { this.skip(); } // does not work in Github_CI
      const version = await getAPIVersion(true);
      try {
        const versionFromGitTag = execSync('git describe --tags')
          .toString()
          .trim();
        assert.strictEqual(version, versionFromGitTag);
      } catch (err) {
        // test fails in CI because no .git/
        if (err.message.includes('not a git repository')) { return; }
        assert.fail(err);
      }
    });
  });
});
