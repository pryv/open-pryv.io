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

function pick (obj: any, keys: any) {
  const out: any = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

const { _internals } = require('../_internals.ts');
const treeUtils = require('../../../../shared/treeUtils.ts');

const STREAM_PROPERTIES = [
  'id', 'name', 'parentId', 'clientData', 'children',
  'trashed', 'created', 'createdBy', 'modified', 'modifiedBy'
];

/**
 * Local data store: streams implementation.
 */
const userStreams = ds.createUserStreams({
  userStreamsStorage: null,
  streamsCollection: null,

  init (streamsCollection: any, userStreamsStorage: any) {
    this.userStreamsStorage = userStreamsStorage;
    this.streamsCollection = streamsCollection;
  },

  async get (userId: any, query: any) {
    const allStreams = await this._getAllFromAccountAndCache(userId);
    if (query.includeTrashed) {
      return structuredClone(allStreams);
    } else {
      // i.e. default behavior (return non-trashed items)
      return treeUtils.filterTree(allStreams, false /* no orphans */, (stream: any) => !stream.trashed);
    }
  },

  async getOne (userId: any, streamId: any, query: any) {
    assert.ok(streamId !== '*' && streamId != null);

    const allStreams = await this._getAllFromAccountAndCache(userId);
    let stream: any = null;

    const foundStream = treeUtils.findById(allStreams, streamId); // find the stream
    if (foundStream != null) {
      const childrenDepth = Object.hasOwnProperty.call(query, 'childrenDepth') ? query.childrenDepth : -1;
      stream = cloneStream(foundStream, childrenDepth);
    }

    if (stream == null) return null;

    if (!query.includeTrashed) {
      if (stream.trashed) return null;
      // i.e. default behavior (return non-trashed items)
      stream.children = treeUtils.filterTree(stream.children, false /* no orphans */, (stream: any) => !stream.trashed);
    }

    return stream;
  },

  async _getAllFromAccountAndCache (userId: any) {
    let allStreamsForAccount = _internals.cache.getStreams(userId, 'local');
    if (allStreamsForAccount != null) return allStreamsForAccount;

    // get from DB
    allStreamsForAccount = await fromCallback((cb: any) => this.userStreamsStorage.find({ id: userId }, {}, null, cb));
    _internals.cache.setStreams(userId, 'local', allStreamsForAccount);
    return allStreamsForAccount;
  },

  /**
   * @param [options]
   */
  async getDeletions (userId: any, query: any, options: any) {
    const dbOptions: any = { sort: { deleted: options?.sortAscending ? 1 : -1 } };
    if (options?.limit != null) dbOptions.limit = options.limit;
    if (options?.skip != null) dbOptions.skip = options.skip;
    const deletedStreams = await fromCallback((cb: any) => this.userStreamsStorage.findDeletions({ id: userId }, query.deletedSince, options, cb));
    return deletedStreams;
  },

  async createDeleted (userId: any, streamData: any) {
    streamData.userId = userId;
    streamData.streamId = streamData.id;
    delete streamData.id;
    return await this.streamsCollection.replaceOne({ userId, streamId: streamData.streamId }, streamData, { upsert: true }); // replace of create deleted streams
  },

  async create (userId: any, streamData: any) {
    // as we have mixed deletions and non deleted in the same table
    // remove eventual deleted items matching this id.
    const deletedStreams = await this.getDeletions(userId, { deletedSince: Number.MIN_SAFE_INTEGER });
    const deletedStream = deletedStreams.filter((s: any) => s.id === streamData.id);
    if (deletedStream.length > 0) {
      await fromCallback((cb: any) => this.userStreamsStorage.removeOne({ id: userId }, { id: deletedStream[0].id }, cb));
    }
    return await fromCallback((cb: any) => this.userStreamsStorage.insertOne({ id: userId }, streamData, cb));
  },

  async update (userId: any, streamData: any) {
    return await fromCallback((cb: any) => this.userStreamsStorage.updateOne({ id: userId }, { id: streamData.id }, streamData, cb));
  },

  async delete (userId: any, streamId: any) {
    return await fromCallback((cb: any) => this.userStreamsStorage.delete({ id: userId }, { id: streamId }, cb));
  },

  async deleteAll (userId: any) {
    await fromCallback((cb: any) => this.userStreamsStorage.removeAll({ id: userId }, cb));
    _internals.cache.unsetUserData(userId);
  },

  async _deleteUser (userId: any) {
    return await fromCallback((cb: any) => this.userStreamsStorage.removeMany(userId, {}, cb));
  },

  async _getStorageInfos (userId: any) {
    const count = await fromCallback((cb: any) => this.userStreamsStorage.countAll(userId, cb));
    return { count };
  }
});

export { userStreams };

function cloneStream (stream: any, childrenDepth: any) {
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
