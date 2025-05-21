/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
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

const path = require('path');
const chai = require('chai');
const assert = chai.assert;
const { execSync } = require('child_process');
const fs = require('fs');
const { getAPIVersion } = require('../../src/project_version');

const versionFilePath = path.join(__dirname, '../../../../', '.api-version');

describe('APIVersion#version', () => {
  describe('when a ".api-version" file exists in the project and is !== that 1.2.3', () => {
    before(() => {
      fs.writeFileSync(versionFilePath, '1.2.4', {
        encoding: 'utf-8'
      });
    });
    after(() => {
      // put test version back in place
      fs.writeFileSync(versionFilePath, '1.2.3', {
        encoding: 'utf-8'
      });
    });
    it('[5ICP] reads .api-version and returns that constant', async () => {
      const version = await getAPIVersion(true);
      assert.strictEqual(version, '1.2.4');
    });
  });
  describe('when a ".api-version" file exists in the project and is 1.2.3', () => {
    before(() => {
      const versionRead = fs.readFileSync(versionFilePath, {
        encoding: 'utf-8'
      });
      assert(versionRead === '1.2.3', '.apiversion file content should be 1.2.3');
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
