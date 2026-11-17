/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import type { Logger } from '@pryv/boiler';
const require = createRequire(import.meta.url);

const EventEmitter = require('events');
const { getLogger } = require('@pryv/boiler');
const logger = getLogger('messages:pubsub');
const CONSTANTS = require('./constants.ts');

type PubSubOptions = {
  transport?: string;
  forwardToTests?: boolean;
  forwardToInternal?: boolean;
};
type Subscription = { unsubscribe: () => void; isConfirmed: () => boolean };
// A keyed subscription, recorded as soon as it is asked for: `sub` is set when
// the transport answers, so a removal before that still unsubscribes.
type KeyedSubscription = { sub: Subscription | null; counter: number };
type Transport = {
  subscribe (scope: string, target: PubSub): Promise<Subscription>;
  deliver (scope: string, eventName: string, payload: unknown): void;
  setTestDeliverHook (hook: (...args: unknown[]) => void): void;
  onConnectionStateChange (listener: (state: 'disconnected' | 'reconnected') => void): () => void;
};
type TestNotifier = { emit (eventName: string, payload?: unknown): void };

// Generic implementation of pub / sub messaging

class PubSub extends EventEmitter {
  options: PubSubOptions;
  transport!: Transport | null;
  scopeName: string;
  logger: Logger;
  transportSubMap: Map<string, KeyedSubscription>; // transport subscriptions by key

  constructor (scopeName: string, options: PubSubOptions = {}) {
    super();
    this.options = Object.assign({
      transport: CONSTANTS.TRANSPORT_MODE_ALL,
      forwardToTests: false,
      forwardToInternal: true
    }, options);

    this.scopeName = scopeName;
    this.logger = logger.getLogger(this.scopeName);
    this.transportSubMap = new Map();

    if (this.options.transport !== CONSTANTS.TRANSPORT_MODE_NONE) {
      initTransport();
    }
    if ((transport != null) && (this.options.transport === CONSTANTS.TRANSPORT_MODE_ALL)) {
      transport.subscribe(this.scopeName, this);
    }
  }

  on (eventName: string, listener: (...args: unknown[]) => void) {
    // keyed listeners
    if ((transport != null) && (this.options.transport === CONSTANTS.TRANSPORT_MODE_KEY)) {
      const existing = this.transportSubMap.get(eventName);
      if (existing == null) { // not yet listening .. subscribe
        const entry: KeyedSubscription = { sub: null, counter: 1 };
        this.transportSubMap.set(eventName, entry);
        transport.subscribe(this.scopeName + '.' + eventName, this).then((sub: Subscription) => {
          // Removed (or replaced) while the transport answered: let it go.
          if (this.transportSubMap.get(eventName) !== entry) { sub.unsubscribe(); return; }
          entry.sub = sub;
        }, (err: Error) => {
          // Never confirmed: nothing built on this key is trusted.
          this.logger.warn('subscribe failed for', eventName, err?.message);
        });
      } else {
        existing.counter++; // count listeners
      }
    }
    super.on(eventName, listener);
  }

  /**
   * True once the transport confirmed the keyed subscription for `eventName`:
   * every message published to it from then on reaches this process.
   */
  isSubscribed (eventName: string): boolean {
    return this.transportSubMap.get(eventName)?.sub?.isConfirmed() === true;
  }

  /**
   * Add-on to EventEmmitter that returns a function to be called to
   * @returns function
   */
  onAndGetRemovable (eventName: string, listener: (...args: unknown[]) => void) {
    this.on(eventName, listener);
    return () => {
      this.off(eventName, listener);
      const entry = this.transportSubMap.get(eventName);
      if ((transport != null) && (this.options.transport === CONSTANTS.TRANSPORT_MODE_KEY) && (entry != null)) {
        this.logger.debug('off', eventName);
        entry.counter--;
        if (entry.counter === 0) { // no more listeners
          this.transportSubMap.delete(eventName);
          entry.sub?.unsubscribe(); // not answered yet: the answer unsubscribes
        }
      }
    };
  }

  emit (eventName: string, payload: unknown) {
    // Not the payload: a cache bust carries the token of an access that is still valid.
    this.logger.debug('emit', eventName, this.options);
    if (this.options.forwardToInternal) super.emit(eventName, payload); // forward to internal listener

    if (this.options.forwardToTests) forwardToTests(eventName, payload);

    if (transport != null) {
      if (this.options.transport === CONSTANTS.TRANSPORT_MODE_ALL) transport.deliver(this.scopeName, eventName, payload);
      if (this.options.transport === CONSTANTS.TRANSPORT_MODE_KEY) transport.deliver(this.scopeName + '.' + eventName, eventName, payload);
    }
  }

  _emit (eventName: string, payload: unknown) {
    super.emit(eventName, payload); // forward to internal listener
    this.logger.debug('_emit', eventName);
  }
}

// ----- Transport

let transport: Transport | null = null;
function initTransport () {
  if (transport != null) return;
  transport = require('./tcp_pubsub.ts');
  logger.debug('initTransport');
}

// ----- TEST Messaging

const testMessageMap: Record<string, string> = {};
testMessageMap[CONSTANTS.USERNAME_BASED_EVENTS_CHANGED] = 'test-events-changed';
testMessageMap[CONSTANTS.USERNAME_BASED_STREAMS_CHANGED] = 'test-streams-changed';
testMessageMap[CONSTANTS.USERNAME_BASED_ACCESSES_CHANGED] = 'test-accesses-changed';
testMessageMap[CONSTANTS.USERNAME_BASED_ACCOUNT_CHANGED] = 'test-account-changed';

let globalTestNotifier: TestNotifier | null = null;

function forwardToTests (eventName: string, payload: unknown) {
  if (globalTestNotifier == null) return;
  if (eventName === CONSTANTS.SERVER_READY) {
    return globalTestNotifier.emit('test-server-ready');
  }
  const testMessageKey = testMessageMap[String(payload)];
  if (testMessageKey) {
    globalTestNotifier.emit(testMessageKey, eventName);
  }
}

// ---- Exports

class PubSubFactory {
  _status: PubSub | null = null;
  _webhooks: PubSub | null = null;
  _series: PubSub | null = null;
  _notifications: PubSub | null = null;
  _scopedNotifications: PubSub | null = null;
  _cache: PubSub | null = null;
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

  // Dedicated channel for scope-matched notifications: structured payloads
  // carrying the changed resource so a notification engine can match standing
  // scopes without re-querying. Keyed by username, like `notifications`, but
  // kept separate so legacy coarse-signal consumers are never exposed to these
  // payloads.
  get scopedNotifications () {
    if (this._scopedNotifications == null) {
      this._scopedNotifications = new PubSub('scopedNotifications', { transport: CONSTANTS.TRANSPORT_MODE_KEY });
      this._scopedNotifications.setMaxListeners(100);
    }
    return this._scopedNotifications;
  }

  get cache () {
    if (this._cache == null) {
      this._cache = new PubSub('cache', { transport: CONSTANTS.TRANSPORT_MODE_KEY, forwardToInternal: false });
      this._cache.setMaxListeners(1); // 1 is enough
    }
    return this._cache;
  }

  setTestNotifier (testNotifier: TestNotifier) {
    globalTestNotifier = testNotifier;
  }

  setTestDeliverHook (deliverHook: (...args: unknown[]) => void) {
    if (transport == null) {
      console.log(new Error('Transport not initialized'));
    }
    transport!.setTestDeliverHook(deliverHook);
  }

  // Broker connection lost / restored (messages in between are lost).
  onTransportStateChange (listener: (state: 'disconnected' | 'reconnected') => void): () => void {
    initTransport();
    return transport!.onConnectionStateChange(listener);
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
