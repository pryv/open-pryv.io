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
type StoreDescription = { id: string; includeInStarPermission?: boolean; [k: string]: unknown };
type DataStore = {
  init: (params: Record<string, unknown>) => Promise<unknown>;
  deleteUser: (userId: string) => Promise<unknown>;
  getUserStorageInfos?: (userId: string) => Promise<unknown>;
  [k: string]: unknown;
};
type IntegrityModule = { events: { compute (e: unknown): { integrity: string } } };

class Mall {
  storesById: Map<string, DataStore> = new Map();
  storeDescriptionsByStore: Map<DataStore, StoreDescription> = new Map();
  /**
   * Contains the list of stores included in star permissions.
   */
  includedInStarPermissions: string[] = [];

  _events!: InstanceType<typeof MallUserEvents>;
  _streams!: InstanceType<typeof MallUserStreams>;

  initialized = false;

  get streams () {
    return this._streams;
  }

  get events () {
    return this._events;
  }

  /**
   * Register a DataStore
   */
  addStore (store: DataStore, storeDescription: StoreDescription) {
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
      const params: Record<string, unknown> = {
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
        params.settings = Object.assign({}, params.settings as Record<string, unknown> | undefined, { streamTree });
      }
      await store.init(params);
    }
    this._streams = new MallUserStreams(this);
    this._events = new MallUserEvents(this);
    return this;
  }

  async deleteUser (userId: string) {
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
  */
  async getUserStorageInfos (userId: string) {
    const storageInfos: Record<string, unknown> = { };
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
*/
function getEventIntegrityFn (storeId: string, integrity: IntegrityModule) {
  return function setIntegrityForEvent (storeEventData: Record<string, unknown>) {
    const event = eventsUtils.convertEventFromStore(storeId, storeEventData);
    storeEventData.integrity = integrity.events.compute(event).integrity;
  };
}
