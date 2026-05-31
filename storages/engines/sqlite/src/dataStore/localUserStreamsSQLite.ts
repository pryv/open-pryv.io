/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { fromCallback } = require('utils');
const assert = require('assert');
const ds = require('@pryv/datastore');
const treeUtils = require('../../../../shared/treeUtils.ts');
const { UserBaseStorageDb } = require('../userBaseStorage/UserBaseStorageDb.ts');
const { _internals } = require('../_internals.ts');

const STREAM_PROPERTIES = [
  'id', 'name', 'parentId', 'clientData', 'children',
  'trashed', 'created', 'createdBy', 'modified', 'modifiedBy'
];

function pick (obj: any, keys: string[]): any {
  const out: any = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

function cloneStream (stream: any, childrenDepth: number): any {
  if (childrenDepth === -1) return structuredClone(stream);
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

/**
 * SQLite data store: streams implementation. Mirrors localUserStreamsPG;
 * the SQLite engine doesn't get the `cache` internal (manifest), so reads
 * always go through storage (no memoization).
 */
const userStreams = ds.createUserStreams({
  userStreamsStorage: null,

  init (this: any, userStreamsStorage: any): void {
    this.userStreamsStorage = userStreamsStorage;
  },

  async _getAllFromAccountAndCache (this: any, userId: string): Promise<any> {
    if (_internals.cache) {
      const cached = _internals.cache.getStreams(userId, 'local');
      if (cached != null) return cached;
    }
    const all = await fromCallback((cb: any) =>
      this.userStreamsStorage.find({ id: userId }, {}, null, cb));
    if (_internals.cache) _internals.cache.setStreams(userId, 'local', all);
    return all;
  },

  async get (this: any, userId: string, query: any): Promise<any> {
    const all = await this._getAllFromAccountAndCache(userId);
    if (query.includeTrashed) return structuredClone(all);
    return treeUtils.filterTree(all, false, (s: any) => !s.trashed);
  },

  async getOne (this: any, userId: string, streamId: string, query: any): Promise<any> {
    assert.ok(streamId !== '*' && streamId != null);

    const all = await this._getAllFromAccountAndCache(userId);
    const found = treeUtils.findById(all, streamId);
    if (found == null) return null;

    const childrenDepth = Object.hasOwnProperty.call(query, 'childrenDepth') ? query.childrenDepth : -1;
    const stream = cloneStream(found, childrenDepth);

    if (!query.includeTrashed) {
      if (stream.trashed) return null;
      stream.children = treeUtils.filterTree(stream.children, false, (s: any) => !s.trashed);
    }
    return stream;
  },

  async getDeletions (this: any, userId: string, query: any, options: any): Promise<any> {
    return await fromCallback((cb: any) =>
      this.userStreamsStorage.findDeletions({ id: userId }, query.deletedSince, options, cb));
  },

  async createDeleted (this: any, userId: string, streamData: any): Promise<void> {
    const udb = await UserBaseStorageDb.forUser(userId);
    await udb.ensureTable('streams', { withDeleted: true, withHeadId: false });

    const existing = udb.db.prepare('SELECT id FROM streams WHERE id = ?').get(streamData.id);
    const dataJson = JSON.stringify({
      name: null,
      parentId: null,
      path: streamData.id + '/'
    });
    if (existing) {
      udb.db.prepare('UPDATE streams SET deleted = ?, data = ? WHERE id = ?')
        .run(streamData.deleted, dataJson, streamData.id);
    } else {
      udb.db.prepare('INSERT INTO streams (id, deleted, data) VALUES (?, ?, ?)')
        .run(streamData.id, streamData.deleted, dataJson);
    }
  },

  async create (this: any, userId: string, streamData: any): Promise<any> {
    const deleted = await this.getDeletions(userId, { deletedSince: Number.MIN_SAFE_INTEGER });
    const match = deleted.filter((s: any) => s.id === streamData.id);
    if (match.length > 0) {
      await fromCallback((cb: any) =>
        this.userStreamsStorage.removeOne({ id: userId }, { id: match[0].id }, cb));
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
    if (_internals.cache) _internals.cache.unsetUserData(userId);
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

export { userStreams };
