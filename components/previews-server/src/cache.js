// @flow

const fs = require('fs');
const timestamp = require('unix-timestamp');
const xattr = require('fs-xattr');
const { resolve } = require('path');
const { readdir } = require('fs').promises;

type CacheSettings  = {
  maxAge: number;
  rootPath: string;
  logger: Object;
}

// Basic implementation for file cache cleanup, relying on xattr.
class Cache {
  settings: CacheSettings;
  cleanUpInProgress: boolean;

  static EventModifiedXattrKey = 'user.pryv.eventModified';
  static LastAccessedXattrKey = 'user.pryv.lastAccessed'

  constructor(settings: CacheSettings) {
    this.settings = settings;
    this.cleanUpInProgress = false;
  }

  // Removes all cached files that haven't been accessed since the given time.
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
      } catch(err) {
        // log and ignore file
        this.settings.logger.warn(`Could not process file "${file}": ${err}`);
      }
    }

    this.cleanUpInProgress = false;
  }
}

async function getFiles(dir) {
  const dirents = await readdir(dir, { withFileTypes: true });
  const files = dirents.map((dirent) => {
    const res = resolve(dir, dirent.name);
    return dirent.isDirectory() ? getFiles(res) : res;
  });
  return Array.prototype.concat(...files);
}

module.exports = Cache;