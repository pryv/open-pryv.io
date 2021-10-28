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

const EventEmitter = require('events');
const { getConfigUnsafe,  getLogger } = require('@pryv/boiler');
const logger = getLogger('messages:pubsub');
const CONSTANTS = require('./constants');
const isOpenSource = getConfigUnsafe(true).get('openSource:isActive');

// Generic implementation of pub / sub messaging

class PubSub extends EventEmitter {
  options;
  nats; 
  scopeName;
  logger;
  natsSubscriptionMap; // map that contains nats subscriptions by key

  constructor(scopeName, options = {}) {
    super();
    this.options = Object.assign({
      nats: CONSTANTS.NATS_MODE_ALL,
      forwardToTests: false,
      forwardToInternal: true,
    }, options);
    
    this.scopeName = scopeName;
    this.logger = logger.getLogger(this.scopeName);
    this.natsSubscriptionMap = {};
    
    if (this.options.nats != CONSTANTS.NATS_MODE_NONE) {
      initNats();
    }
    if ((nats != null) && (this.options.nats == CONSTANTS.NATS_MODE_ALL)) {
      nats.subscribe(this.scopeName, this);
    }
  }

  on(eventName, listener) {
    // nats "keyed" listeners
    if ((nats != null) && (this.options.nats == CONSTANTS.NATS_MODE_KEY)) {
      if (this.natsSubscriptionMap[eventName] == null) { // not yet listening .. subscribe
        nats.subscribe(this.scopeName + '.' + eventName, this).then((sub) => {
          this.natsSubscriptionMap[eventName] = {sub: sub, counter: 1};
        });
      } else {
        this.natsSubscriptionMap[eventName].counter++; // count listners for nats eventName
      }
    }
    super.on(eventName, listener);
  }

  /**
   * Add-on to EventEmmitter that returns a function to be called to 
   * @returns function
   */
  onAndGetRemovable(eventName, listener) {
    this.on(eventName, listener);
    return function() {
      this.off(eventName, listener);
      if ((nats != null) && (this.options.nats == CONSTANTS.NATS_MODE_KEY) && (this.natsSubscriptionMap[eventName] != null)) {
        this.logger.debug('off', eventName);
        this.natsSubscriptionMap[eventName].counter--;
        if (this.natsSubscriptionMap[eventName].counter == 0) { // no more listeners .. close nats subscription
          this.natsSubscriptionMap[eventName].sub.unsubscribe();
          delete this.natsSubscriptionMap[eventName];
        }
      }
    }.bind(this);
  }

  emit(eventName, payload) {
    this.logger.debug('emit', eventName, payload, this.options);
    if (this.options.forwardToInternal) super.emit(eventName, payload); // forward to internal listener 
    
    if (this.options.forwardToTests) forwardToTests(eventName, payload);

    if (nats != null) {
      if (this.options.nats == CONSTANTS.NATS_MODE_ALL) nats.deliver(this.scopeName, eventName, payload);
      if (this.options.nats == CONSTANTS.NATS_MODE_KEY) nats.deliver(this.scopeName + '.' + eventName, eventName, payload); 
    }
  }

  _emit(eventName, payload) {
    super.emit(eventName, payload); // forward to internal listener
    this.logger.debug('_emit', eventName, payload);
  }

}

// ----- NATS 

let nats = null;
function initNats() {
  if (nats != null || isOpenSource) return;
  nats = require('./nats_pubsub');
  logger.debug('initNats');
}


// ----- TEST Messaging

const testMessageMap = {};
testMessageMap[CONSTANTS.USERNAME_BASED_EVENTS_CHANGED] = 'axon-events-changed';
testMessageMap[CONSTANTS.USERNAME_BASED_STREAMS_CHANGED] = 'axon-streams-changed';
testMessageMap[CONSTANTS.USERNAME_BASED_FOLLOWEDSLICES_CHANGED] = 'axon-followed-slices-changed';
testMessageMap[CONSTANTS.USERNAME_BASED_ACCESSES_CHANGED] = 'axon-accesses-changed';
testMessageMap[CONSTANTS.USERNAME_BASED_ACCOUNT_CHANGED] = 'axon-account-changed';

let globalTestNotifier = null;


function forwardToTests(eventName, payload) {
  if (eventName == CONSTANTS.SERVER_READY) { 
    return globalTestNotifier.emit('axon-server-ready');
  }
  const testMessageKey = testMessageMap[payload];
  if (testMessageKey) {
    globalTestNotifier.emit(testMessageKey, eventName);
  }
}

// ---- Exports

class PubSubFactory {
  _status;
  _webhooks;
  _series;
  _notifications;
  _cache;
  get status() {
    if (this._status == null) this._status =  new PubSub('status', {nats: CONSTANTS.NATS_MODE_NONE, forwardToTests: true});
    this._status.setMaxListeners(1); // 1 is enough
    return this._status;
  }
  get webhooks() {
    if (this._webhooks == null) this._webhooks =  new PubSub('webhooks');
    this._webhooks.setMaxListeners(10); // 1 should be enough but setting 10 for tests 
    return this._webhooks;
  }
  get series() {
    if (this._series == null) this._series =  new PubSub('series');
    this._series.setMaxListeners(1); // 1 is enough
    return this._series;
  }
  get notifications() {
    if (this._notifications == null) {
      this._notifications =  new PubSub('notifications', {nats: CONSTANTS.NATS_MODE_KEY, forwardToTests: true});
      this._notifications.setMaxListeners(100); // Number of max socket.io or webhooks connections
    }
    return this._notifications;
  }
  get cache() {
    if (this._cache == null) {
      this._cache =  new PubSub('cache', {nats: CONSTANTS.NATS_MODE_KEY, forwardToInternal: false});
      this._cache.setMaxListeners(1); // 1 is enough
    }
    return this._cache;
  }
  setTestNotifier(testNotifier) {
    globalTestNotifier = testNotifier;
  }
}

const pubSubFactory = new PubSubFactory();

Object.assign(pubSubFactory, CONSTANTS);

module.exports = pubSubFactory;

