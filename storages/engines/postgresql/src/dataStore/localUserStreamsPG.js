/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const bluebird = require('bluebird');
const assert = require('assert');
const ds = require('@pryv/datastore');

function pick (obj, keys) {
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

const _internals = require('../_internals');
const treeUtils = require('../../../../shared/treeUtils');

const STREAM_PROPERTIES = [
  'id', 'name', 'parentId', 'clientData', 'children',
  'trashed', 'created', 'createdBy', 'modified', 'modifiedBy'
];

/**
 * PostgreSQL data store: streams implementation.
 * Implements the @pryv/datastore UserStreams interface.
 *
 * Uses the StorageLayer's StreamsPG (callback-based) under the hood,
 * wrapping its calls in Promises via bluebird.fromCallback.
 */
module.exports = ds.createUserStreams({
  userStreamsStorage: null,

  init (userStreamsStorage) {
    this.userStreamsStorage = userStreamsStorage;
  },

  async get (userId, query) {
    const allStreams = await this._getAllFromAccountAndCache(userId);
    if (query.includeTrashed) {
      return structuredClone(allStreams);
    } else {
      return treeUtils.filterTree(allStreams, false, (stream) => !stream.trashed);
    }
  },

  async getOne (userId, streamId, query) {
    assert.ok(streamId !== '*' && streamId != null);

    const allStreams = await this._getAllFromAccountAndCache(userId);
    let stream = null;

    const foundStream = treeUtils.findById(allStreams, streamId);
    if (foundStream != null) {
      const childrenDepth = Object.hasOwnProperty.call(query, 'childrenDepth') ? query.childrenDepth : -1;
      stream = cloneStream(foundStream, childrenDepth);
    }

    if (stream == null) return null;

    if (!query.includeTrashed) {
      if (stream.trashed) return null;
      stream.children = treeUtils.filterTree(stream.children, false, (s) => !s.trashed);
    }

    return stream;
  },

  async _getAllFromAccountAndCache (userId) {
    let allStreamsForAccount = _internals.cache.getStreams(userId, 'local');
    if (allStreamsForAccount != null) return allStreamsForAccount;

    // Get from DB via StorageLayer's StreamsPG (callback-based)
    allStreamsForAccount = await bluebird.fromCallback((cb) =>
      this.userStreamsStorage.find({ id: userId }, {}, null, cb));
    _internals.cache.setStreams(userId, 'local', allStreamsForAccount);
    return allStreamsForAccount;
  },

  async getDeletions (userId, query, options) {
    const deletedStreams = await bluebird.fromCallback((cb) =>
      this.userStreamsStorage.findDeletions({ id: userId }, query.deletedSince, options, cb));
    return deletedStreams;
  },

  async createDeleted (userId, streamData) {
    // For PG, upsert a deleted stream record
    const db = this.userStreamsStorage.db;
    const existing = await db.query(
      'SELECT id FROM streams WHERE user_id = $1 AND id = $2',
      [userId, streamData.id]
    );
    if (existing.rows.length > 0) {
      await db.query(
        'UPDATE streams SET deleted = $2, name = NULL, parent_id = NULL WHERE user_id = $1 AND id = $3',
        [userId, streamData.deleted, streamData.id]
      );
    } else {
      await db.query(
        `INSERT INTO streams (user_id, id, name, path, deleted)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, streamData.id, streamData.name || null, streamData.id + '/', streamData.deleted]
      );
    }
  },

  async create (userId, streamData) {
    // Remove any existing deleted version of this stream
    const deletedStreams = await this.getDeletions(userId, { deletedSince: Number.MIN_SAFE_INTEGER });
    const deletedStream = deletedStreams.filter(s => s.id === streamData.id);
    if (deletedStream.length > 0) {
      await bluebird.fromCallback((cb) =>
        this.userStreamsStorage.removeOne({ id: userId }, { id: deletedStream[0].id }, cb));
    }
    return await bluebird.fromCallback((cb) =>
      this.userStreamsStorage.insertOne({ id: userId }, streamData, cb));
  },

  async update (userId, streamData) {
    return await bluebird.fromCallback((cb) =>
      this.userStreamsStorage.updateOne({ id: userId }, { id: streamData.id }, streamData, cb));
  },

  async delete (userId, streamId) {
    return await bluebird.fromCallback((cb) =>
      this.userStreamsStorage.delete({ id: userId }, { id: streamId }, cb));
  },

  async deleteAll (userId) {
    await bluebird.fromCallback((cb) =>
      this.userStreamsStorage.removeAll({ id: userId }, cb));
    _internals.cache.unsetUserData(userId);
  },

  async _deleteUser (userId) {
    return await bluebird.fromCallback((cb) =>
      this.userStreamsStorage.removeMany(userId, {}, cb));
  },

  async _getStorageInfos (userId) {
    const count = await bluebird.fromCallback((cb) =>
      this.userStreamsStorage.countAll(userId, cb));
    return { count };
  }
});

function cloneStream (stream, childrenDepth) {
  if (childrenDepth === -1) {
    return structuredClone(stream);
  } else {
    const StreamPropsWithoutChildren = STREAM_PROPERTIES.filter((p) => p !== 'children');
    const copy = pick(stream, StreamPropsWithoutChildren);
    if (childrenDepth === 0) {
      copy.childrenHidden = true;
      copy.children = [];
    } else if (stream.children) {
      copy.children = stream.children.map((s) => cloneStream(s, childrenDepth - 1));
    }
    return copy;
  }
}
