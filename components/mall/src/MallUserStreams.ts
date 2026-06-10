/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const storeDataUtils = require('./helpers/storeDataUtils.ts');
const streamsUtils = require('./helpers/streamsUtils.ts');
const { treeUtils } = require('utils');
const { createId: cuid } = require('@paralleldrive/cuid2');
const errorFactory = require('errors').factory;

type Stream = {
  id: string;
  name?: string;
  parentId?: string | null;
  trashed?: boolean;
  deleted?: number | null;
  children?: Stream[];
  childrenHidden?: boolean;
  [k: string]: unknown;
};
type StreamsStore = {
  getOne (userId: string, streamId: string, opts: Record<string, unknown>): Promise<Stream | null>;
  get (userId: string, opts: Record<string, unknown>): Promise<Stream[]>;
  getDeletions (userId: string, opts: { deletedSince: number }): Promise<Stream[]>;
  create (userId: string, streamData: Stream): Promise<Stream>;
  createDeleted (userId: string, streamData: Stream): Promise<Stream>;
  update (userId: string, streamData: Stream): Promise<Stream>;
  delete (userId: string, streamId: string): Promise<unknown>;
  deleteAll (userId: string): Promise<unknown>;
  hasFeatureGetParamsExcludedIds?: boolean;
};
type StoresHolder = {
  storesById: Map<string, { streams: StreamsStore, supports?: () => Record<string, unknown> }>;
  storeDescriptionsByStore: Map<{ streams: StreamsStore }, { name: string }>;
};
type GetParams = {
  id?: string;
  storeId?: string;
  childrenDepth?: number;
  excludedIds?: string[];
  hideStoreRoots?: boolean;
  includeTrashed?: boolean;
};

/**
 * Storage for streams.
 * Dispatches requests to each data store's streams.
 */
class MallUserStreams {
  /**
   * @default new Map()
   */
  streamsStores: Map<string, StreamsStore> = new Map();
  /**
   * Store names are used for the stores' root pseudo-streams.
   * @default new Map()
   */
  storeNames: Map<string, string> = new Map();

  /** Per-store `DataStore.supports` declarations (announced on root pseudo-streams). */
  storeSupports: Map<string, Record<string, unknown>> = new Map();

  constructor (storesHolder: StoresHolder) {
    for (const [storeId, store] of storesHolder.storesById) {
      this.streamsStores.set(storeId, store.streams);
      this.storeNames.set(storeId, storesHolder.storeDescriptionsByStore.get(store)!.name);
      this.storeSupports.set(storeId, typeof store.supports === 'function' ? store.supports() : {});
    }
  }

  /**
   * Extra properties for a store's root pseudo-stream: announce the store's
   * capability declaration to clients via clientData (when non-empty).
   */
  _rootStreamExtras (storeId: string): Record<string, unknown> {
    const supports = this.storeSupports.get(storeId);
    if (supports == null || Object.keys(supports).length === 0) return {};
    return { clientData: { 'pryv-datastore:supports': supports } };
  }

  /**
   * Get a single stream from id and optional storeId.
   * Will not expand children.
   * @param [storeId]
   */
  async getOneWithNoChildren (userId: string, streamId: string, storeId?: string): Promise<Stream | null> {
    if (storeId == null) {
      [storeId, streamId] = storeDataUtils.parseStoreIdAndStoreItemId(streamId);
    }
    const sid = storeId!;
    const streamsStore = this.streamsStores.get(sid);
    if (!streamsStore) { return null; }

    if (streamId === '*' && sid !== 'local') {
      return streamsUtils.createStoreRootStream({
        id: sid,
        name: this.storeNames.get(sid)
      }, {
        children: [],
        childrenHidden: true, // To be discussed
        ...this._rootStreamExtras(sid)
      });
    }

    const stream = await streamsStore.getOne(userId, streamId, {
      includeTrashed: true,
      childrenDepth: 0
    });
    return stream;
  }

  /**
   * Get the stream that will be set as root for all Stream Structure of this Data Store.
   * @see https://pryv.github.io/reference/#get-streams
   * @param userId  undefined
   * @param params  undefined
   */
  async get (userId: string, params: GetParams): Promise<Stream[]> {
    // -------- cleanup params --------- //
    let streamId = params.id || '*';
    let storeIdRaw = params.storeId;
    if (storeIdRaw == null) {
      [storeIdRaw, streamId] = storeDataUtils.parseStoreIdAndStoreItemId(streamId);
    }
    const storeId = storeIdRaw!;
    params.childrenDepth = params.childrenDepth || 0;
    const excludedIds = params.excludedIds || [];
    const hideStoreRoots = params.hideStoreRoots || false;
    // ------- create result ------//
    let res: Stream[] = [];
    // *** root query we just expose store handles & local streams
    // might be moved in localDataStore ?
    if (streamId === '*' &&
            storeId === storeDataUtils.LocalStoreId &&
            !hideStoreRoots) {
      res = getChildlessRootStreamsForOtherStores(this);
    }
    // ------ Query Store -------------//
    const streamsStore = this.streamsStores.get(storeId)!;
    if (streamsStore == null) {
      throw errorFactory.unknownResource('Store', storeId);
    }
    const storeQuery = {
      includeTrashed: params.includeTrashed,
      childrenDepth: params.childrenDepth,
      excludedIds: streamsStore.hasFeatureGetParamsExcludedIds
        ? excludedIds
        : []
    };

    if (streamId !== '*') {
      const stream = await streamsStore.getOne(userId, streamId, storeQuery);
      if (stream != null) res.push(stream);
    } else { // root query
      const streams = await streamsStore.get(userId, storeQuery);
      res.push(...streams);

      // For root queries on local store, also include account store streams
      // (account is passthrough — its stream IDs are already correct)
      if (storeId === storeDataUtils.LocalStoreId) {
        const accountStore = this.streamsStores.get(storeDataUtils.AccountStoreId);
        if (accountStore) {
          const accountStreams = await accountStore.get(userId, storeQuery);
          res.push(...accountStreams);
        }
      }
    }

    // if store does not support excludeIds, perform it here
    if (!streamsStore.hasFeatureGetParamsExcludedIds &&
            excludedIds.length > 0) {
      res = performExclusion(res, excludedIds);
    }
    if (storeId !== storeDataUtils.LocalStoreId) {
      // add Prefix
      streamsUtils.addStoreIdPrefixToStreams(storeId, res);
      if (streamId === '*') {
        // add root stream
        res = [
          streamsUtils.createStoreRootStream({
            id: storeId,
            name: this.storeNames.get(storeId)
          }, {
            children: res,
            ...this._rootStreamExtras(storeId)
          })
        ];
      }
    }
    return res;
    function getChildlessRootStreamsForOtherStores (self: MallUserStreams): Stream[] {
      const res: Stream[] = [];
      for (const [storeId, storeName] of self.storeNames) {
        // Passthrough stores (local, account) don't get pseudo-root streams
        if (!storeDataUtils.isPassthroughStore(storeId)) {
          res.push(streamsUtils.createStoreRootStream({
            id: storeId,
            name: storeName
          }, {
            children: [],
            childrenHidden: true, // To be discussed
            ...self._rootStreamExtras(storeId)
          }));
        }
      }
      return res;
    }
    function performExclusion (res: Stream[], excludedIds: string[]): Stream[] {
      return treeUtils.filterTree(res, false, (stream: Stream) => !excludedIds.includes(stream.id));
    }
  }

  /**
   * @param [deletedSince]
   * @param [storeIds]
   */
  async getDeletions (userId: string, deletedSince?: number | null, storeIds?: string[]): Promise<Stream[]> {
    if (deletedSince == null) { deletedSince = Number.MIN_SAFE_INTEGER; }
    storeIds = storeIds || [storeDataUtils.LocalStoreId];
    const result: Stream[] = [];
    for (const storeId of storeIds) {
      const streamsStore = this.streamsStores.get(storeId)!;
      const deletedStreams = await streamsStore.getDeletions(userId, { deletedSince });
      result.push(...deletedStreams);
    }
    return result;
  }

  /**
   * As some stores might not keep "deletion" records
   * A "local" cache of deleted streams could be implemented
   * This is mostly used by tests fixtures for now
   */
  async createDeleted (userId: string, streamData: Stream): Promise<Stream> {
    const [storeId] = storeDataUtils.parseStoreIdAndStoreItemId(streamData.id);
    if (streamData.deleted == null) { throw errorFactory.invalidRequestStructure('Missing deleted timestamp for deleted stream', streamData); }
    const streamsStore = this.streamsStores.get(storeId)!;
    const res = await streamsStore.createDeleted(userId, streamData);
    return res;
  }

  async create (userId: string, streamData: Stream): Promise<Stream> {
    if (streamData.deleted != null) {
      return await this.createDeleted(userId, streamData);
    }
    const streamForStore = structuredClone(streamData);
    // 0- Prepare default values
    if (streamForStore.trashed !== true) {
      delete streamForStore.trashed;
    }
    if (streamForStore.deleted === undefined) {
      streamForStore.deleted = null;
    }
    // 1- Check if there is a parent stream
    let parentStoreId = storeDataUtils.LocalStoreId;
    let parentStoreStreamId;
    if (streamForStore.parentId != null) {
      [parentStoreId, parentStoreStreamId] =
                storeDataUtils.parseStoreIdAndStoreItemId(streamData.parentId);
      streamForStore.parentId = parentStoreStreamId;
    }
    // 2- Check streamId and store
    let storeId, storeStreamId;
    if (streamForStore.id == null) {
      storeId = parentStoreId;
      streamForStore.id = cuid();
    } else {
      [storeId, storeStreamId] = storeDataUtils.parseStoreIdAndStoreItemId(streamData.id);
      if (parentStoreId !== storeId) {
        throw errorFactory.invalidRequestStructure('streams cannot have an id different non matching from their parentId store', streamData);
      }
      streamForStore.id = storeStreamId;
    }
    const streamsStore = this.streamsStores.get(storeId)!;
    // 3 - Check if this Id has already been taken
    const existingStream = await streamsStore.getOne(userId, streamForStore.id, { includeTrashed: true });
    if (existingStream != null) {
      throw errorFactory.itemAlreadyExists('stream', { id: streamData.id });
    }

    // 4- Check if a sibbling stream with the same name exists
    const siblingNames = await this.getNamesOfChildren(userId, streamData.parentId, []);
    if (siblingNames.includes(streamForStore.name)) {
      throw errorFactory.itemAlreadyExists('stream', { name: streamData.name });
    }
    // 3 - Insert stream
    const res = await streamsStore.create(userId, streamForStore);

    if (storeId !== storeDataUtils.LocalStoreId) {
      // add Prefix
      streamsUtils.addStoreIdPrefixToStreams(storeId, [res]);
    }
    return res;
  }

  async update (userId: string, streamData: Stream): Promise<Stream> {
    const streamForStore = structuredClone(streamData);
    const [storeId, storeStreamId] = storeDataUtils.parseStoreIdAndStoreItemId(streamData.id);
    streamForStore.id = storeStreamId;

    // 1- Check if there is a parent stream update
    if (streamForStore.parentId != null) {
      const [parentStoreId, parentStoreStreamId] = storeDataUtils.parseStoreIdAndStoreItemId(streamData.parentId);
      if (parentStoreId !== storeId) {
        throw errorFactory.invalidRequestStructure('streams cannot have an id different non matching from their parentId store', streamData);
      }
      streamForStore.parentId = parentStoreStreamId;
    }

    // 2- Check if a sibbling stream with the same name exists
    const siblingNames = await this.getNamesOfChildren(userId, streamData.parentId, [streamData.id]);
    if (siblingNames.includes(streamForStore.name)) {
      throw errorFactory.itemAlreadyExists('stream', { name: streamData.name });
    }
    // 3 - Insert stream
    const streamsStore = this.streamsStores.get(storeId)!;
    const res = await streamsStore.update(userId, streamForStore);
    if (storeId !== storeDataUtils.LocalStoreId) {
      // add Prefix
      streamsUtils.addStoreIdPrefixToStreams(storeId, [res]);
    }
    return res;
  }

  // ---------------------- delete ----------------- //
  async delete (userId: string, streamId: string): Promise<unknown> {
    const [storeId, storeStreamId] = storeDataUtils.parseStoreIdAndStoreItemId(streamId);
    const streamsStore = this.streamsStores.get(storeId)!;
    return await streamsStore.delete(userId, storeStreamId);
  }

  /**
   * Used by tests
   * Might be replaced by standard delete.
   * @param userId  undefined
   */
  async deleteAll (userId: string, storeId: string): Promise<void> {
    const streamsStore = this.streamsStores.get(storeId)!;
    await streamsStore.deleteAll(userId);
  }

  // -------------------- utils ------------------- //
  /**
   * @private
   * get name of children stream
   */
  async getNamesOfChildren (userId: string, streamId: string | null | undefined, exludedIds: string[]): Promise<Array<string | undefined>> {
    const streams = await this.get(userId, {
      id: streamId ?? undefined,
      childrenDepth: 1,
      includeTrashed: true
    });
    let streamsToCheck: Stream[] = [];
    if (streamId == null) {
      // root
      streamsToCheck = streams;
    } else if (streams.length > 0) {
      streamsToCheck = streams[0].children || [];
    }
    const names = streamsToCheck
      .filter((s: Stream) => !exludedIds.includes(s.id))
      .map((s: Stream) => s.name);
    return names;
  }
}
export default MallUserStreams;
export { MallUserStreams };
