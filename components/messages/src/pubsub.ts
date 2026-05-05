/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const EventEmitter = require('events');
const { getLogger } = require('@pryv/boiler');
const logger = getLogger('messages:pubsub');
const CONSTANTS = require('./constants');

// Generic implementation of pub / sub messaging

class PubSub extends EventEmitter {
  options;
  transport;
  scopeName;
  logger;
  transportSubMap; // map that contains transport subscriptions by key

  constructor (scopeName, options = {}) {
    super();
    this.options = Object.assign({
      transport: CONSTANTS.TRANSPORT_MODE_ALL,
      forwardToTests: false,
      forwardToInternal: true
    }, options);

    this.scopeName = scopeName;
    this.logger = logger.getLogger(this.scopeName);
    this.transportSubMap = {};

    if (this.options.transport !== CONSTANTS.TRANSPORT_MODE_NONE) {
      initTransport();
    }
    if ((transport != null) && (this.options.transport === CONSTANTS.TRANSPORT_MODE_ALL)) {
      transport.subscribe(this.scopeName, this);
    }
  }

  on (eventName, listener) {
    // keyed listeners
    if ((transport != null) && (this.options.transport === CONSTANTS.TRANSPORT_MODE_KEY)) {
      if (this.transportSubMap[eventName] == null) { // not yet listening .. subscribe
        transport.subscribe(this.scopeName + '.' + eventName, this).then((sub) => {
          this.transportSubMap[eventName] = { sub, counter: 1 };
        });
      } else {
        this.transportSubMap[eventName].counter++; // count listeners
      }
    }
    super.on(eventName, listener);
  }

  /**
   * Add-on to EventEmmitter that returns a function to be called to
   * @returns function
   */
  onAndGetRemovable (eventName, listener) {
    this.on(eventName, listener);
    return function () {
      this.off(eventName, listener);
      if ((transport != null) && (this.options.transport === CONSTANTS.TRANSPORT_MODE_KEY) && (this.transportSubMap[eventName] != null)) {
        this.logger.debug('off', eventName);
        this.transportSubMap[eventName].counter--;
        if (this.transportSubMap[eventName].counter === 0) { // no more listeners
          this.transportSubMap[eventName].sub.unsubscribe();
          delete this.transportSubMap[eventName];
        }
      }
    }.bind(this);
  }

  emit (eventName, payload) {
    this.logger.debug('emit', eventName, payload, this.options);
    if (this.options.forwardToInternal) super.emit(eventName, payload); // forward to internal listener

    if (this.options.forwardToTests) forwardToTests(eventName, payload);

    if (transport != null) {
      if (this.options.transport === CONSTANTS.TRANSPORT_MODE_ALL) transport.deliver(this.scopeName, eventName, payload);
      if (this.options.transport === CONSTANTS.TRANSPORT_MODE_KEY) transport.deliver(this.scopeName + '.' + eventName, eventName, payload);
    }
  }

  _emit (eventName, payload) {
    super.emit(eventName, payload); // forward to internal listener
    this.logger.debug('_emit', eventName, payload);
  }
}

// ----- Transport

let transport = null;
function initTransport () {
  if (transport != null) return;
  transport = require('./tcp_pubsub');
  logger.debug('initTransport');
}

// ----- TEST Messaging

const testMessageMap = {};
testMessageMap[CONSTANTS.USERNAME_BASED_EVENTS_CHANGED] = 'test-events-changed';
testMessageMap[CONSTANTS.USERNAME_BASED_STREAMS_CHANGED] = 'test-streams-changed';
testMessageMap[CONSTANTS.USERNAME_BASED_ACCESSES_CHANGED] = 'test-accesses-changed';
testMessageMap[CONSTANTS.USERNAME_BASED_ACCOUNT_CHANGED] = 'test-account-changed';

let globalTestNotifier = null;

function forwardToTests (eventName, payload) {
  if (eventName === CONSTANTS.SERVER_READY) {
    return globalTestNotifier.emit('test-server-ready');
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
  get status () {
    if (this._status == null) this._status = new PubSub('status', { transport: CONSTANTS.TRANSPORT_MODE_NONE, forwardToTests: true });
    this._status.setMaxListeners(1); // 1 is enough
    return this._status;
  }

  get webhooks () {
    if (this._webhooks == null) this._webhooks = new PubSub('webhooks');
    this._webhooks.setMaxListeners(10); // 1 should be enough but setting 10 for tests
    return this._webhooks;
  }

  get series () {
    if (this._series == null) this._series = new PubSub('series');
    this._series.setMaxListeners(1); // 1 is enough
    return this._series;
  }

  get notifications () {
    if (this._notifications == null) {
      this._notifications = new PubSub('notifications', { transport: CONSTANTS.TRANSPORT_MODE_KEY, forwardToTests: true });
      this._notifications.setMaxListeners(100); // Number of max socket.io or webhooks connections
    }
    return this._notifications;
  }

  get cache () {
    if (this._cache == null) {
      this._cache = new PubSub('cache', { transport: CONSTANTS.TRANSPORT_MODE_KEY, forwardToInternal: false });
      this._cache.setMaxListeners(1); // 1 is enough
    }
    return this._cache;
  }

  setTestNotifier (testNotifier) {
    globalTestNotifier = testNotifier;
  }

  setTestDeliverHook (deliverHook) {
    if (transport == null) {
      console.log(new Error('Transport not initialized'));
    }
    transport.setTestDeliverHook(deliverHook);
  }

  // used by tests to detect true "OpenSource" setup
  isTransportEnabled () {
    return transport != null;
  }
}

const pubSubFactory = new PubSubFactory();

Object.assign(pubSubFactory, CONSTANTS);

export default pubSubFactory;
export { pubSubFactory };
