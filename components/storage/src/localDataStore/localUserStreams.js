/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

const bluebird = require('bluebird');
const assert = require('assert');
const _ = require('lodash');
const cache = require('cache');
const ds = require('@pryv/datastore');
const { treeUtils } = require('utils');
const { StreamProperties } = require('business/src/streams');
const StreamPropsWithoutChildren = StreamProperties.filter((p) => p !== 'children');
const SystemStreamsSerializer = require('business/src/system-streams/serializer'); // loaded just to init upfront
let visibleStreamsTree = [];

/**
 * Local data store: streams implementation.
 */
module.exports = ds.createUserStreams({
  userStreamsStorage: null,
  streamsCollection: null,

  init (streamsCollection, userStreamsStorage) {
    this.userStreamsStorage = userStreamsStorage;
    this.streamsCollection = streamsCollection;
    loadVisibleStreamsTree();
  },

  async get (userId, query) {
    const allStreams = await this._getAllFromAccountAndCache(userId);
    if (query.includeTrashed) {
      return structuredClone(allStreams);
    } else {
      // i.e. default behavior (return non-trashed items)
      return treeUtils.filterTree(allStreams, false /* no orphans */, (stream) => !stream.trashed);
    }
  },

  async getOne (userId, streamId, query) {
    assert.ok(streamId !== '*' && streamId != null);

    const allStreams = await this._getAllFromAccountAndCache(userId);
    let stream = null;

    const foundStream = treeUtils.findById(allStreams, streamId); // find the stream
    if (foundStream != null) {
      const childrenDepth = Object.hasOwnProperty.call(query, 'childrenDepth') ? query.childrenDepth : -1;
      stream = cloneStream(foundStream, childrenDepth);
    }

    if (stream == null) return null;

    if (!query.includeTrashed) {
      if (stream.trashed) return null;
      // i.e. default behavior (return non-trashed items)
      stream.children = treeUtils.filterTree(stream.children, false /* no orphans */, (stream) => !stream.trashed);
    }

    return stream;
  },

  async _getAllFromAccountAndCache (userId) {
    let allStreamsForAccount = cache.getStreams(userId, 'local');
    if (allStreamsForAccount != null) return allStreamsForAccount;

    // get from DB
    allStreamsForAccount = await bluebird.fromCallback((cb) => this.userStreamsStorage.find({ id: userId }, {}, null, cb));
    // add system streams
    allStreamsForAccount = allStreamsForAccount.concat(visibleStreamsTree);
    cache.setStreams(userId, 'local', allStreamsForAccount);
    return allStreamsForAccount;
  },

  /**
   * @param {string} userId
   * @param {{deletedSince: timestamp}} query
   * @param {{skip: number, limit: number, sortAscending: boolean}} [options]
   * @returns {Promise<any[]>}
   */
  async getDeletions (userId, query, options) {
    const dbOptions = { sort: { deleted: options?.sortAscending ? 1 : -1 } };
    if (options?.limit != null) dbOptions.limit = options.limit;
    if (options?.skip != null) dbOptions.skip = options.skip;
    const deletedStreams = await bluebird.fromCallback((cb) => this.userStreamsStorage.findDeletions({ id: userId }, query.deletedSince, options, cb));
    return deletedStreams;
  },

  async createDeleted (userId, streamData) {
    streamData.userId = userId;
    streamData.streamId = streamData.id;
    delete streamData.id;
    return await this.streamsCollection.replaceOne({ userId, streamId: streamData.streamId }, streamData, { upsert: true }); // replace of create deleted streams
  },

  async create (userId, streamData) {
    // as we have mixed deletions and non deleted in the same table
    // remove eventual deleted items matching this id.
    const deletedStreams = await this.getDeletions(userId, { deletedSince: Number.MIN_SAFE_INTEGER });
    const deletedStream = deletedStreams.filter(s => s.id === streamData.id);
    if (deletedStream.length > 0) {
      await bluebird.fromCallback((cb) => this.userStreamsStorage.removeOne({ id: userId }, { id: deletedStream[0].id }, cb));
    }
    return await bluebird.fromCallback((cb) => this.userStreamsStorage.insertOne({ id: userId }, streamData, cb));
  },

  async update (userId, streamData) {
    return await bluebird.fromCallback((cb) => this.userStreamsStorage.updateOne({ id: userId }, { id: streamData.id }, streamData, cb));
  },

  async delete (userId, streamId) {
    return await bluebird.fromCallback((cb) => this.userStreamsStorage.delete({ id: userId }, { id: streamId }, cb));
  },

  async deleteAll (userId) {
    await bluebird.fromCallback((cb) => this.userStreamsStorage.removeAll({ id: userId }, cb));
    cache.unsetUserData(userId);
  },

  async _deleteUser (userId) {
    return await bluebird.fromCallback((cb) => this.userStreamsStorage.removeMany(userId, {}, cb));
  },

  async _getStorageInfos (userId) {
    const count = await bluebird.fromCallback((cb) => this.userStreamsStorage.countAll(userId, cb));
    return { count };
  }
});

/**
 * @param {object} stream
 * @param {number} childrenDepth
 * @returns {object}
 */
function cloneStream (stream, childrenDepth) {
  if (childrenDepth === -1) {
    return structuredClone(stream);
  } else {
    const copy = _.pick(stream, StreamPropsWithoutChildren);
    if (childrenDepth === 0) {
      copy.childrenHidden = true;
      copy.children = [];
    } else if (stream.children) {
      copy.children = stream.children.map((s) => cloneStream(s, childrenDepth - 1));
    }
    return copy;
  }
}

/**
 * @returns {void}
 */
function loadVisibleStreamsTree () {
  try {
    visibleStreamsTree = SystemStreamsSerializer.getReadable();
    ds.defaults.applyOnStreams(visibleStreamsTree);
  } catch (err) {
    console.log('This should be fixed!! It happens when the system streams are not yet loaded during some test suites.. ', err);
  }
}
