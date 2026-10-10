/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import type { Logger } from '@pryv/boiler';
const require = createRequire(import.meta.url);

const fs = require('fs');
const timestamp = require('unix-timestamp');
const xattr = require('fs-xattr');
const { resolve } = require('path');
const { readdir } = require('fs').promises;

type CacheSettings = {
  maxAge: number;
  rootPath: string;
  logger: Logger;
};

type DirEntLike = { name: string; isDirectory: () => boolean };

// Basic implementation for file cache cleanup, relying on xattr.

class Cache {
  settings: CacheSettings;

  cleanUpInProgress: boolean;
  /** @static
   * @default 'user.pryv.eventModified'
   */
  static EventModifiedXattrKey = 'user.pryv.eventModified';
  /** @static
   * @default 'user.pryv.lastAccessed'
   */
  static LastAccessedXattrKey = 'user.pryv.lastAccessed';
  /** @static
   * Identifies the attachment a cached file was made from.
   * @default 'user.pryv.sourceAttachment'
   */
  static SourceAttachmentXattrKey = 'user.pryv.sourceAttachment';
  constructor (settings: CacheSettings) {
    this.settings = settings;
    this.cleanUpInProgress = false;
  }

  // Removes all cached files that haven't been accessed since the given time.
  async cleanUp (): Promise<void> {
    if (this.cleanUpInProgress) {
      throw new Error('Clean-up is already in progress.');
    }
    this.cleanUpInProgress = true;
    try {
      const cutoffTime = timestamp.now() - this.settings.maxAge;
      let files: string[];
      try {
        files = await getFiles(this.settings.rootPath);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        // the root folder is only created with the first preview: nothing to clean
        if (e.code === 'ENOENT' && e.path === this.settings.rootPath) {
          this.settings.logger.debug(`Nothing to clean: "${this.settings.rootPath}" does not exist`);
          return;
        }
        throw err;
      }
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
    } finally {
      this.cleanUpInProgress = false;
    }
  }
}
async function getFiles (dir: string): Promise<string[]> {
  const dirents = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all((dirents as DirEntLike[]).map((dirent: DirEntLike) => {
    const res = resolve(dir, dirent.name);
    return dirent.isDirectory() ? getFiles(res) : res;
  }));
  return Array.prototype.concat(...files);
}
export default Cache;
export { Cache };
