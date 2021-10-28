/**
 * @license
 * Copyright (C) 2020-2021 Pryv S.A. https://pryv.com 
 * 
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 * 
 * Redistribution and use in source and binary forms, with or without 
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, 
 *    this list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice, 
 *    this list of conditions and the following disclaimer in the documentation 
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its contributors 
 *    may be used to endorse or promote products derived from this software 
 *    without specific prior written permission.
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

// @flow

/**
 * Data Store aggregator. 
 * Pack configured datastores into one
 */

const errors = require('errors').factory;

const { DataStore } = require('../interfaces/DataStore');

// --- Override Error handling 

DataStore.throwInvalidRequestStructure = function(message, data) {
  throw(errors.invalidRequestStructure(message, data, innerError));
}

DataStore.throwUnkownRessource = function(resourceType, id, innerError) {
  throw(errors.unknownResource(resourceType, id, innerError));
}


// -- Core properties
const MallUserStreams = require('./MallUserStreams');
const StoreUserEvents = require('./MallUserEvents');

class Mall extends DataStore {

  _id: string = 'store';
  _name: string = 'Store';
  stores: Array<DataStore>;
  storesMap: Map<string, DataStore>;
  initialized: boolean;
  _streams: MallUserStreams;
  _events: StoreUserEvents;

  constructor() {
    super();
    this.storesMap = {};
    this.stores = [];
    this.initialized = false;
  }

  get streams(): MallUserStreams { return this._streams; }
  get events(): StoreUserEvents { return this._events; }

  /**
   * register a new DataStore
   * @param 
   */
  addStore(store: DataStore): void {
    if (this.initialized) throw(new Error('Sources cannot be added after init()'));
    this.stores.push(store);
    this.storesMap[store.id] = store;
  }

  async init(): Promise<Mall> {
    if (this.initialized) throw(new Error('init() can only be called once.'));
    this.initialized = true;

    // initialize all stores
    for (const store: DataStore of this.stores) {
      await store.init();
    }

    // expose streams and events;
    this._streams = new MallUserStreams(this);
    this._events = new StoreUserEvents(this);
    
    return this;
  }

  /**
   * @private
   * @param {identifier} storeId 
   * @returns 
   */
  _storeForId(storeId: string): DataStore {
    return this.storesMap[storeId];
  }

}

module.exports = Mall;