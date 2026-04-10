/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
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
  const files = await Promise.all(dirents.map((dirent) => {
    const res = resolve(dir, dirent.name);
    return dirent.isDirectory() ? getFiles(res) : res;
  }));
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
