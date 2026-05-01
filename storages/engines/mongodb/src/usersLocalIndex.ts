/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * Contains UserName >> UserId Mapping
 */

import type {} from 'node:fs';

class DBIndex {
  id4nameCollection;

  async init () {
    const _internals = require('./_internals');
    const db = _internals.database;
    this.id4nameCollection = await db.getCollection({
      name: 'id4name',
      indexes: [
        {
          index: { userId: 1 },
          options: { unique: true }
        },
        {
          index: { username: 1 },
          options: { unique: true }
        }
      ]
    });
  }

  async getIdForName (username) {
    const res = await this.id4nameCollection.findOne({ username });
    return res?.userId;
  }

  async getNameForId (userId) {
    const res = await this.id4nameCollection.findOne({ userId });
    return res?.username;
  }

  async addUser (username, userId) {
    return await this.id4nameCollection.insertOne({ userId, username });
  }

  async deleteById (userId) {
    return await this.id4nameCollection.deleteOne({ userId });
  }

  /**
   * @returns {Object} An object whose keys are the usernames and values are the user ids.
   */
  async getAllByUsername () {
    const allCursor = this.id4nameCollection.find({});
    const users = {};
    for await (const user of allCursor) {
      users[user.username] = user.userId;
    }
    return users;
  }

  async deleteAll () {
    return await this.id4nameCollection.deleteMany({});
  }

  // --- Migration methods --- //

  async exportAll () {
    return await this.getAllByUsername();
  }

  async importAll (data) {
    for (const [username, userId] of Object.entries(data)) {
      await this.addUser(username, userId);
    }
  }

  async clearAll () {
    return await this.deleteAll();
  }
}

module.exports = DBIndex;
