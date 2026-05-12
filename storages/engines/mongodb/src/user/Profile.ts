/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { BaseStorage } = require('./BaseStorage.ts');
const converters = require('./../converters.ts');

/**
 * DB persistence for profile sets.
 */
class Profile extends BaseStorage {
  defaultOptions: any;

  constructor (database: any) {
    super(database);

    Object.assign(this.converters, {
      updateToDB: [converters.getKeyValueSetUpdateFn('data')],
      convertIdToItemId: 'profileId'
    });

    this.defaultOptions = {
      sort: {}
    };
  }

  /** Override importAll: convert canonical backup format `id` → MongoDB `profileId`. */
  importAll (userOrUserId: any, items: any, callback: any) {
    const mapped = items.map((item: any) => {
      const doc = Object.assign({}, item);
      if (doc.id != null && doc.profileId == null) {
        doc.profileId = doc.id;
        delete doc.id;
      }
      return doc;
    });
    super.importAll(userOrUserId, mapped, callback);
  }

  getCollectionInfo (userOrUserId: any) {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    return {
      name: 'profile',
      indexes: [{
        index: { profileId: 1 },
        options: { unique: true }
      }],
      useUserId: userId
    };
  }
}

export { Profile };
