/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
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
const storeDataUtils = require('./helpers/storeDataUtils');
const MallUserStreams = require('./MallUserStreams');
const MallUserEvents = require('./MallUserEvents');
const MallTransaction = require('./MallTransaction');
const { getLogger } = require('@pryv/boiler');
const eventsUtils = require('./helpers/eventsUtils');

/**
 * Storage for streams and events.
 * Under the hood, manages the different data stores (built-in and custom),
 * dispatching data requests for each one.
 */
class Mall {
  /**
   * @type {Map<string, DataStore>}
   */
  storesById = new Map();
  /**
   * @type {Map<DataStore, {id: string, name: string, settings: object}>}
   */
  storeDescriptionsByStore = new Map();
  /**
   * Contains the list of stores included in star permissions.
   * @type {string[]}
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
   * @param {DataStore} store
   * @param {{ id: string, name: string, settings: object}} storeDescription
   * @returns {void}
   */
  addStore (store, storeDescription) {
    if (this.initialized) { throw new Error('Sources cannot be added after init()'); }
    this.storesById.set(storeDescription.id, store);
    this.storeDescriptionsByStore.set(store, storeDescription);
    if (storeDescription.includeInStarPermission) {
      this.includedInStarPermissions.push(storeDescription.id);
    }
  }

  /**
   * @returns {Promise<this>}
   */
  async init () {
    if (this.initialized) { throw new Error('init() can only be called once.'); }
    this.initialized = true;
    // placed here otherwise create a circular dependency .. pfff
    const { getUserAccountStorage } = require('storage');
    const userAccountStorage = await getUserAccountStorage();
    const { integrity } = require('business');
    for (const [storeId, store] of this.storesById) {
      const storeKeyValueData = userAccountStorage.getKeyValueDataForStore(storeId);
      const params = {
        ...this.storeDescriptionsByStore.get(store),
        storeKeyValueData,
        logger: getLogger(`mall:${storeId}`),
        integrity: { setOnEvent: getEventIntegrityFn(storeId, integrity) }
      };
      await store.init(params);
    }
    this._streams = new MallUserStreams(this);
    this._events = new MallUserEvents(this);
    return this;
  }

  /**
   * @returns {Promise<void>}
  */
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
   * Return the quantity of storage used by the user in bytes.
   * @param {string} userId
   * @returns {Promise<number>}
  */
  async getUserStorageSize (userId) {
    let storageUsed = 0;
    for (const [storeId, store] of this.storesById) {
      try {
        if (store.getUserStorageSize != null) {
          // undocumented feature of DataStore, skip if not implemented
          storageUsed += await store.getUserStorageSize(userId);
        }
      } catch (error) {
        storeDataUtils.throwAPIError(error, storeId);
      }
    }
    return storageUsed;
  }

  /**
   * @param {string} storeId
   * @returns {Promise<any>}
  */
  async newTransaction () {
    return new MallTransaction(this);
  }
}
module.exports = Mall;

/**
 * Get store-specific integrity calculation function
 * @param {string} storeId
 * @param {*} integrity
 * @returns {Function}
*/
function getEventIntegrityFn (storeId, integrity) {
  return function setIntegrityForEvent (storeEventData) {
    const event = eventsUtils.convertEventFromStore(storeId, storeEventData);
    storeEventData.integrity = integrity.events.compute(event).integrity;
  };
}
