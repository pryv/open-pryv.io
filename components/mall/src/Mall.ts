/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const storeDataUtils = require('./helpers/storeDataUtils.ts');
const MallUserStreams = require('./MallUserStreams.ts').default;
const MallUserEvents = require('./MallUserEvents.ts').default;
const MallTransaction = require('./MallTransaction.ts').default;
const { getLogger } = require('@pryv/boiler');
const eventsUtils = require('./helpers/eventsUtils.ts');

/**
 * Storage for streams and events.
 * Under the hood, manages the different data stores (built-in and custom),
 * dispatching data requests for each one.
 */
class Mall {
  storesById = new Map();
  storeDescriptionsByStore = new Map();
  /**
   * Contains the list of stores included in star permissions.
   */
  includedInStarPermissions = [];

  _events;
  _streams;

  initialized = false;

  get streams () {
    return this._streams;
  }

  get events () {
    return this._events;
  }

  /**
   * Register a DataStore
   * @param store
   * @param storeDescription
   */
  addStore (store, storeDescription) {
    if (this.initialized) { throw new Error('Sources cannot be added after init()'); }
    this.storesById.set(storeDescription.id, store);
    this.storeDescriptionsByStore.set(store, storeDescription);
    if (storeDescription.includeInStarPermission) {
      this.includedInStarPermissions.push(storeDescription.id);
    }
  }

  async init () {
    if (this.initialized) { throw new Error('init() can only be called once.'); }
    this.initialized = true;
    // placed here otherwise create a circular dependency .. pfff
    const { getUserAccountStorage } = require('storage');
    const userAccountStorage = await getUserAccountStorage();
    const { integrity } = require('business');

    // Pre-compute system streams data so engines don't need the serializer
    const accountStreams = require('business/src/system-streams/index.ts');
    await accountStreams.init();
    const systemStreams = {
      accountStreamIds: Object.keys(accountStreams.accountMap)
    };

    // Build account store stream tree from system streams config (includes type info)
    const { treeUtils } = require('utils');
    const accountRoot = treeUtils.findById(accountStreams.allAsTree, ':_system:account');

    for (const [storeId, store] of this.storesById) {
      const storeKeyValueData = userAccountStorage.getKeyValueDataForStore(storeId);
      const params = {
        ...this.storeDescriptionsByStore.get(store),
        storeKeyValueData,
        logger: getLogger(`mall:${storeId}`),
        integrity: { setOnEvent: getEventIntegrityFn(storeId, integrity) }
      };
      if (storeId === 'local') {
        params.systemStreams = systemStreams;
      }
      if (storeId === 'account' && accountRoot) {
        const streamTree = [structuredClone(accountRoot)];
        params.settings = Object.assign({}, params.settings, { streamTree });
      }
      await store.init(params);
    }
    this._streams = new MallUserStreams(this);
    this._events = new MallUserEvents(this);
    return this;
  }

  async deleteUser (userId) {
    for (const [storeId, store] of this.storesById) {
      try {
        await store.deleteUser(userId);
      } catch (error) {
        storeDataUtils.throwAPIError(error, storeId);
      }
    }
  }

  /**
   * Return storage informations per store Id.
   * @param userId
  */
  async getUserStorageInfos (userId) {
    const storageInfos = { };
    for (const [storeId, store] of this.storesById) {
      try {
        if (store.getUserStorageInfos != null) {
          // undocumented feature of DataStore, skip if not implemented
          storageInfos[storeId] = await store.getUserStorageInfos(userId);
        }
      } catch (error) {
        storeDataUtils.throwAPIError(error, storeId);
      }
    }
    return storageInfos;
  }

  async newTransaction () {
    return new MallTransaction(this);
  }
}
export default Mall;
export { Mall };

/**
 * Get store-specific integrity calculation function
 * @param storeId
 * @param integrity
*/
function getEventIntegrityFn (storeId, integrity) {
  return function setIntegrityForEvent (storeEventData) {
    const event = eventsUtils.convertEventFromStore(storeId, storeEventData);
    storeEventData.integrity = integrity.events.compute(event).integrity;
  };
}
