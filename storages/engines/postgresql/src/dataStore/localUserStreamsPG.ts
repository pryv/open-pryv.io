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
import type { UserStorage } from '../../../../interfaces/baseStorage/UserStorage.ts';

/** The PG streams storage handle is a BaseStoragePG instance — the UserStorage
 *  9-method contract plus its `.db` (used directly by createDeleted). */
type PgDbLike = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
type UserStreamsStoragePG = UserStorage & { db: PgDbLike };

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
  userStreamsStorage: UserStreamsStoragePG;
  // own helper methods of the store literal, so `this.<helper>()` typechecks
  _getAllFromAccountAndCache (userId: string): Promise<Stream[]>;
  getDeletions (userId: string, query: DeletionsQuery, options?: DeletionsOptions): Promise<Stream[]>;
};

function pick<T extends Record<string, unknown>> (obj: T, keys: string[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (k in obj) out[k as keyof T] = obj[k as keyof T];
  return out;
}

const { _internals } = require('../_internals.ts');
const { treeUtils } = require('utils');

const STREAM_PROPERTIES = [
  'id', 'name', 'parentId', 'clientData', 'children',
  'trashed', 'created', 'createdBy', 'modified', 'modifiedBy'
];

/**
 * PostgreSQL data store: streams implementation.
 */
const userStreams = ds.createUserStreams({
  userStreamsStorage: null,

  init (this: Store, userStreamsStorage: UserStreamsStoragePG): void {
    this.userStreamsStorage = userStreamsStorage;
  },

  async get (this: Store, userId: string, query: StreamQuery): Promise<Stream[]> {
    const allStreams = await this._getAllFromAccountAndCache(userId);
    if (query.includeTrashed) {
      return structuredClone(allStreams);
    } else {
      return treeUtils.filterTree(allStreams, false, (stream: Stream) => !stream.trashed);
    }
  },

  async getOne (this: Store, userId: string, streamId: string, query: StreamQuery): Promise<Stream | null> {
    assert.ok(streamId !== '*' && streamId != null);

    const allStreams = await this._getAllFromAccountAndCache(userId);
    let stream: Stream | null = null;

    const foundStream = treeUtils.findById(allStreams, streamId);
    if (foundStream != null) {
      const childrenDepth = Object.hasOwnProperty.call(query, 'childrenDepth') ? query.childrenDepth! : -1;
      stream = cloneStream(foundStream, childrenDepth);
    }

    if (stream == null) return null;

    if (!query.includeTrashed) {
      if (stream.trashed) return null;
      stream.children = treeUtils.filterTree(stream.children, false, (s: Stream) => !s.trashed);
    }

    return stream;
  },

  async _getAllFromAccountAndCache (this: Store, userId: string): Promise<Stream[]> {
    let allStreamsForAccount = _internals.cache.getStreams(userId, 'local');
    if (allStreamsForAccount != null) return allStreamsForAccount;

    allStreamsForAccount = await fromCallback((cb: NodeCallback<Stream[]>) =>
      this.userStreamsStorage.find({ id: userId }, {}, null, cb));
    _internals.cache.setStreams(userId, 'local', allStreamsForAccount);
    return allStreamsForAccount;
  },

  async getDeletions (this: Store, userId: string, query: DeletionsQuery, options?: DeletionsOptions): Promise<Stream[]> {
    const deletedStreams = await fromCallback((cb: NodeCallback<Stream[]>) =>
      this.userStreamsStorage.findDeletions({ id: userId }, query.deletedSince, options ?? null, cb));
    return deletedStreams as Stream[];
  },

  async createDeleted (this: Store, userId: string, streamData: Stream): Promise<void> {
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

  async create (this: Store, userId: string, streamData: Stream): Promise<Stream> {
    const deletedStreams = await this.getDeletions(userId, { deletedSince: Number.MIN_SAFE_INTEGER });
    const deletedStream = deletedStreams.filter((s: Stream) => s.id === streamData.id);
    if (deletedStream.length > 0) {
      await fromCallback((cb: NodeCallback) =>
        this.userStreamsStorage.removeOne({ id: userId }, { id: deletedStream[0].id }, cb));
    }
    return await fromCallback((cb: NodeCallback<Stream>) =>
      this.userStreamsStorage.insertOne({ id: userId }, streamData, cb));
  },

  async update (this: Store, userId: string, streamData: Stream): Promise<Stream> {
    return await fromCallback((cb: NodeCallback<Stream>) =>
      this.userStreamsStorage.updateOne({ id: userId }, { id: streamData.id }, streamData, cb));
  },

  async delete (this: Store, userId: string, streamId: string): Promise<unknown> {
    return await fromCallback((cb: NodeCallback) =>
      this.userStreamsStorage.delete({ id: userId }, { id: streamId }, cb));
  },

  async deleteAll (this: Store, userId: string): Promise<void> {
    await fromCallback((cb: NodeCallback) =>
      this.userStreamsStorage.removeAll({ id: userId }, cb));
    _internals.cache.unsetUserData(userId);
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

function cloneStream (stream: Stream, childrenDepth: number): Stream {
  if (childrenDepth === -1) {
    return structuredClone(stream);
  } else {
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
}
