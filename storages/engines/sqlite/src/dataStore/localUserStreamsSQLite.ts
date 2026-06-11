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
const { treeUtils } = require('utils');
const { UserBaseStorageDb } = require('../userBaseStorage/UserBaseStorageDb.ts');
const { _internals } = require('../_internals.ts');
import type { UserStorage } from '../../../../interfaces/baseStorage/UserStorage.ts';

type Stream = {
  id: string;
  name?: string;
  parentId?: string | null;
  clientData?: Record<string, unknown>;
  children?: Stream[];
  childrenHidden?: boolean;
  trashed?: boolean;
  created?: number;
  createdBy?: string;
  modified?: number;
  modifiedBy?: string;
  deleted?: number;
};
type StreamQuery = { includeTrashed?: boolean; childrenDepth?: number };
type DeletionsQuery = { deletedSince: number };
type DeletionsOptions = Record<string, unknown> | null;
type NodeCallback<T = unknown> = (err: Error | null | undefined, value?: T) => void;
type Store = {
  userStreamsStorage: UserStorage;
  // own helper methods of the store literal, so `this.<helper>()` typechecks
  _getAllFromAccountAndCache (userId: string): Promise<Stream[]>;
  getDeletions (userId: string, query: DeletionsQuery, options?: DeletionsOptions): Promise<Stream[]>;
};

const STREAM_PROPERTIES = [
  'id', 'name', 'parentId', 'clientData', 'children',
  'trashed', 'created', 'createdBy', 'modified', 'modifiedBy'
];

function pick<T extends Record<string, unknown>> (obj: T, keys: string[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (k in obj) out[k as keyof T] = obj[k as keyof T];
  return out;
}

function cloneStream (stream: Stream, childrenDepth: number): Stream {
  if (childrenDepth === -1) return structuredClone(stream);
  const StreamPropsWithoutChildren = STREAM_PROPERTIES.filter((p) => p !== 'children');
  const copy = pick(stream as unknown as Record<string, unknown>, StreamPropsWithoutChildren) as Stream;
  if (childrenDepth === 0) {
    copy.childrenHidden = true;
    copy.children = [];
  } else if (stream.children) {
    copy.children = stream.children.map((s) => cloneStream(s, childrenDepth - 1));
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

  init (this: Store, userStreamsStorage: UserStorage): void {
    this.userStreamsStorage = userStreamsStorage;
  },

  async _getAllFromAccountAndCache (this: Store, userId: string): Promise<Stream[]> {
    if (_internals.cache) {
      const cached = _internals.cache.getStreams(userId, 'local');
      if (cached != null) return cached;
    }
    const all = await fromCallback((cb: NodeCallback<unknown[]>) =>
      this.userStreamsStorage.find({ id: userId }, {}, null, cb));
    if (_internals.cache) _internals.cache.setStreams(userId, 'local', all);
    return all as Stream[];
  },

  async get (this: Store, userId: string, query: StreamQuery): Promise<Stream[]> {
    const all = await this._getAllFromAccountAndCache(userId);
    if (query.includeTrashed) return structuredClone(all);
    return treeUtils.filterTree(all, false, (s: Stream) => !s.trashed);
  },

  async getOne (this: Store, userId: string, streamId: string, query: StreamQuery): Promise<Stream | null> {
    assert.ok(streamId !== '*' && streamId != null);

    const all = await this._getAllFromAccountAndCache(userId);
    const found = treeUtils.findById(all, streamId);
    if (found == null) return null;

    const childrenDepth = Object.hasOwnProperty.call(query, 'childrenDepth') ? query.childrenDepth! : -1;
    const stream = cloneStream(found, childrenDepth);

    if (!query.includeTrashed) {
      if (stream.trashed) return null;
      stream.children = treeUtils.filterTree(stream.children, false, (s: Stream) => !s.trashed);
    }
    return stream;
  },

  async getDeletions (this: Store, userId: string, query: DeletionsQuery, options?: DeletionsOptions): Promise<Stream[]> {
    return await fromCallback((cb: NodeCallback<unknown[]>) =>
      this.userStreamsStorage.findDeletions({ id: userId }, query.deletedSince, options ?? null, cb)) as Stream[];
  },

  async createDeleted (this: Store, userId: string, streamData: Stream): Promise<void> {
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

  async create (this: Store, userId: string, streamData: Stream): Promise<Stream> {
    const deleted = await this.getDeletions(userId, { deletedSince: Number.MIN_SAFE_INTEGER });
    const match = deleted.filter((s: Stream) => s.id === streamData.id);
    if (match.length > 0) {
      await fromCallback((cb: NodeCallback) =>
        this.userStreamsStorage.removeOne({ id: userId }, { id: match[0].id }, cb));
    }
    return (await fromCallback((cb: NodeCallback<unknown>) =>
      this.userStreamsStorage.insertOne({ id: userId }, streamData, cb))) as Stream;
  },

  async update (this: Store, userId: string, streamData: Stream): Promise<Stream> {
    return (await fromCallback((cb: NodeCallback<unknown>) =>
      this.userStreamsStorage.updateOne({ id: userId }, { id: streamData.id }, streamData, cb))) as Stream;
  },

  async delete (this: Store, userId: string, streamId: string): Promise<unknown> {
    return await fromCallback((cb: NodeCallback) =>
      this.userStreamsStorage.delete({ id: userId }, { id: streamId }, cb));
  },

  async deleteAll (this: Store, userId: string): Promise<void> {
    await fromCallback((cb: NodeCallback) =>
      this.userStreamsStorage.removeAll({ id: userId }, cb));
    if (_internals.cache) _internals.cache.unsetUserData(userId);
  },

  async _deleteUser (this: Store, userId: string): Promise<unknown> {
    return await fromCallback((cb: NodeCallback) =>
      this.userStreamsStorage.removeMany(userId, {}, cb));
  },

  async _getStorageInfos (this: Store, userId: string): Promise<{ count: number }> {
    const count = await fromCallback((cb: NodeCallback<number>) =>
      this.userStreamsStorage.countAll(userId, cb));
    return { count: count as number };
  }
});

export { userStreams };
