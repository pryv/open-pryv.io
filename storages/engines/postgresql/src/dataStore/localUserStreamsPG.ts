/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type {} from 'node:fs';

const { fromCallback } = require('utils');
const assert = require('assert');
const ds = require('@pryv/datastore');

function pick (obj: any, keys: string[]): any {
  const out: any = {};
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
 */
module.exports = ds.createUserStreams({
  userStreamsStorage: null,

  init (this: any, userStreamsStorage: any): void {
    this.userStreamsStorage = userStreamsStorage;
  },

  async get (this: any, userId: string, query: any): Promise<any> {
    const allStreams = await this._getAllFromAccountAndCache(userId);
    if (query.includeTrashed) {
      return structuredClone(allStreams);
    } else {
      return treeUtils.filterTree(allStreams, false, (stream: any) => !stream.trashed);
    }
  },

  async getOne (this: any, userId: string, streamId: string, query: any): Promise<any> {
    assert.ok(streamId !== '*' && streamId != null);

    const allStreams = await this._getAllFromAccountAndCache(userId);
    let stream: any = null;

    const foundStream = treeUtils.findById(allStreams, streamId);
    if (foundStream != null) {
      const childrenDepth = Object.hasOwnProperty.call(query, 'childrenDepth') ? query.childrenDepth : -1;
      stream = cloneStream(foundStream, childrenDepth);
    }

    if (stream == null) return null;

    if (!query.includeTrashed) {
      if (stream.trashed) return null;
      stream.children = treeUtils.filterTree(stream.children, false, (s: any) => !s.trashed);
    }

    return stream;
  },

  async _getAllFromAccountAndCache (this: any, userId: string): Promise<any> {
    let allStreamsForAccount = _internals.cache.getStreams(userId, 'local');
    if (allStreamsForAccount != null) return allStreamsForAccount;

    allStreamsForAccount = await fromCallback((cb: any) =>
      this.userStreamsStorage.find({ id: userId }, {}, null, cb));
    _internals.cache.setStreams(userId, 'local', allStreamsForAccount);
    return allStreamsForAccount;
  },

  async getDeletions (this: any, userId: string, query: any, options: any): Promise<any> {
    const deletedStreams = await fromCallback((cb: any) =>
      this.userStreamsStorage.findDeletions({ id: userId }, query.deletedSince, options, cb));
    return deletedStreams;
  },

  async createDeleted (this: any, userId: string, streamData: any): Promise<void> {
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

  async create (this: any, userId: string, streamData: any): Promise<any> {
    const deletedStreams = await this.getDeletions(userId, { deletedSince: Number.MIN_SAFE_INTEGER });
    const deletedStream = deletedStreams.filter((s: any) => s.id === streamData.id);
    if (deletedStream.length > 0) {
      await fromCallback((cb: any) =>
        this.userStreamsStorage.removeOne({ id: userId }, { id: deletedStream[0].id }, cb));
    }
    return await fromCallback((cb: any) =>
      this.userStreamsStorage.insertOne({ id: userId }, streamData, cb));
  },

  async update (this: any, userId: string, streamData: any): Promise<any> {
    return await fromCallback((cb: any) =>
      this.userStreamsStorage.updateOne({ id: userId }, { id: streamData.id }, streamData, cb));
  },

  async delete (this: any, userId: string, streamId: string): Promise<any> {
    return await fromCallback((cb: any) =>
      this.userStreamsStorage.delete({ id: userId }, { id: streamId }, cb));
  },

  async deleteAll (this: any, userId: string): Promise<void> {
    await fromCallback((cb: any) =>
      this.userStreamsStorage.removeAll({ id: userId }, cb));
    _internals.cache.unsetUserData(userId);
  },

  async _deleteUser (this: any, userId: string): Promise<any> {
    return await fromCallback((cb: any) =>
      this.userStreamsStorage.removeMany(userId, {}, cb));
  },

  async _getStorageInfos (this: any, userId: string): Promise<any> {
    const count = await fromCallback((cb: any) =>
      this.userStreamsStorage.countAll(userId, cb));
    return { count };
  }
});

function cloneStream (stream: any, childrenDepth: number): any {
  if (childrenDepth === -1) {
    return structuredClone(stream);
  } else {
    const StreamPropsWithoutChildren = STREAM_PROPERTIES.filter((p) => p !== 'children');
    const copy: any = pick(stream, StreamPropsWithoutChildren);
    if (childrenDepth === 0) {
      copy.childrenHidden = true;
      copy.children = [];
    } else if (stream.children) {
      copy.children = stream.children.map((s: any) => cloneStream(s, childrenDepth - 1));
    }
    return copy;
  }
}
