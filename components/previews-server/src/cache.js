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
const fs = require('fs');
const timestamp = require('unix-timestamp');
const xattr = require('fs-xattr');
const { resolve } = require('path');
const { readdir } = require('fs').promises;
// Basic implementation for file cache cleanup, relying on xattr.

class Cache {
  settings;

  cleanUpInProgress;
  /** @static
   * @default 'user.pryv.eventModified'
   */
  static EventModifiedXattrKey = 'user.pryv.eventModified';
  /** @static
   * @default 'user.pryv.lastAccessed'
   */
  static LastAccessedXattrKey = 'user.pryv.lastAccessed';
  constructor (settings) {
    this.settings = settings;
    this.cleanUpInProgress = false;
  }

  // Removes all cached files that haven't been accessed since the given time.
  /**
   * @returns {Promise<void>}
   */
  async cleanUp () {
    if (this.cleanUpInProgress) {
      throw new Error('Clean-up is already in progress.');
    }
    this.cleanUpInProgress = true;
    const cutoffTime = timestamp.now() - this.settings.maxAge;
    const files = await getFiles(this.settings.rootPath);
    for (const file of files) {
      try {
        const value = await xattr.get(file, Cache.LastAccessedXattrKey);
        if (value != null && +value.toString() < cutoffTime) {
          fs.unlinkSync(file);
        }
      } catch (err) {
        // log and ignore file
        this.settings.logger.warn(`Could not process file "${file}": ${err}`);
      }
    }
    this.cleanUpInProgress = false;
  }
}
/**
 * @returns {Promise<any[]>}
 */
async function getFiles (dir) {
  const dirents = await readdir(dir, { withFileTypes: true });
  const files = dirents.map((dirent) => {
    const res = resolve(dir, dirent.name);
    return dirent.isDirectory() ? getFiles(res) : res;
  });
  return Array.prototype.concat(...files);
}
module.exports = Cache;

/**
 * @typedef {{
 *   maxAge: number;
 *   rootPath: string;
 *   logger: any;
 * }} CacheSettings
 */
