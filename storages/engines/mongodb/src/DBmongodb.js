/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const Database = require('./Database');

const _internals = require('./_internals');
const logger = _internals.lazyLogger('platform:db');

class DB {
  platformUnique;
  platformIndexed;
  queries;
  db;

  async init () {
    const settings = structuredClone(_internals.config);
    settings.name = settings.name + '-platform';
    this.db = new Database(settings);
    this.platformUnique = await this.db.getCollection({
      name: 'keyValueUnique',
      indexes: [
        {
          index: { field: 1, value: 1 },
          options: { unique: true }
        }
      ]
    });
    this.platformIndexed = await this.db.getCollection({
      name: 'keyValueIndexed',
      indexes: [
        {
          index: { username: 1, field: 1 },
          options: { unique: true }
        },
        {
          index: { field: 1 },
          options: { }
        }
      ]
    });
    logger.debug('PlatformDB (mongo) initialized');
  }

  /** Used by platformCheckIntegrity  */
  async getAllWithPrefix (prefix) {
    logger.debug('getAllWithPrefix', prefix);
    if (prefix !== 'user') throw new Error('Only [user] prefix is supported');
    const res = (await this.platformIndexed.find({}).toArray()).map((i) => { i.isUnique = false; return i; });
    const uniques = (await this.platformUnique.find({}).toArray()).map((i) => { i.isUnique = true; return i; });
    res.push(...uniques);
    logger.debug('getAllWithPrefixDone', prefix);
    return res;
  }

  /** Used by tests  */
  async deleteAll () {
    logger.debug('deleteAll');
    await this.platformIndexed.deleteMany({});
    await this.platformUnique.deleteMany({});
  }

  // ----- utilities ------- //

  async setUserUniqueField (username, field, value) {
    const item = { field, value, username };
    logger.debug('setUserUniqueField', item);
    await this.platformUnique.updateOne({ field, value }, { $set: item }, { upsert: true });
    return item;
  }

  async setUserUniqueFieldIfNotExists (username, field, value) {
    logger.debug('setUserUniqueFieldIfNotExists', { username, field, value });
    const existing = await this.platformUnique.findOne({ field, value });
    if (existing != null) {
      return existing.username === username;
    }
    await this.platformUnique.updateOne({ field, value }, { $set: { field, value, username } }, { upsert: true });
    return true;
  }

  async deleteUserUniqueField (field, value) {
    logger.debug('deleteUserUniqueField', { field, value });
    await this.platformUnique.deleteOne({ field, value });
  }

  async setUserIndexedField (username, field, value) {
    const item = { field, value, username };
    logger.debug('setUserIndexedField', item);
    await this.platformIndexed.updateOne({ field, username }, { $set: item }, { upsert: true });
  }

  async deleteUserIndexedField (username, field) {
    logger.debug('deleteUserIndexedField', { username, field });
    await this.platformIndexed.deleteOne({ username, field });
  }

  async getUserIndexedField (username, field) {
    logger.debug('getUserIndexedField', { username, field });
    const res = await this.platformIndexed.findOne({ username, field });
    return res?.value || null;
  }

  async getUsersUniqueField (field, value) {
    logger.debug('getUsersUniqueField', { field, value });
    const res = await this.platformUnique.findOne({ field, value });
    return res?.username || null;
  }

  async close () {
    await this.db.close();
    this.db = null;
  }

  isClosed () {
    return this.db == null;
  }

  // --- Migration methods --- //

  async exportAll () {
    return await this.getAllWithPrefix('user');
  }

  async importAll (data) {
    for (const entry of data) {
      if (entry.isUnique) {
        await this.setUserUniqueField(entry.username, entry.field, entry.value);
      } else {
        await this.setUserIndexedField(entry.username, entry.field, entry.value);
      }
    }
  }

  async clearAll () {
    return await this.deleteAll();
  }

  // --- User-to-core mapping --- //

  async setUserCore (username, coreId) {
    await this.setUserIndexedField(username, '_core', coreId);
  }

  async getUserCore (username) {
    return await this.getUserIndexedField(username, '_core');
  }

  async getAllUserCores () {
    const docs = await this.platformIndexed.find({ field: '_core' }).toArray();
    return docs.map(doc => ({
      username: doc.username,
      coreId: doc.value
    }));
  }

  // --- Core registration --- //

  async setCoreInfo (coreId, info) {
    // Store as indexed field with reserved username '__cores__'
    await this.setUserIndexedField('__cores__', coreId, JSON.stringify(info));
  }

  async getCoreInfo (coreId) {
    const val = await this.getUserIndexedField('__cores__', coreId);
    return val != null ? JSON.parse(val) : null;
  }

  async getAllCoreInfos () {
    const docs = await this.platformIndexed.find({ username: '__cores__' }).toArray();
    return docs.map(doc => JSON.parse(doc.value));
  }
}

module.exports = DB;
