/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { getLogger } from '@pryv/boiler';
import { pubsub } from 'messages';
import { LRUCache } from 'lru-cache';
const logger = getLogger('cache:synchro');

interface CacheModule {
  unsetAccessLogic: (userId: string, ref: { id: string; token: string }, propagate: boolean) => void;
  unsetUserData: (userId: string, propagate: boolean) => void;
  unsetUser: (username: string, propagate: boolean) => void;
  unsetUserById: (userId: string, propagate: boolean) => void;
  setUntrusted: () => void;
  flushAfterReconnect: () => void;
}

interface AccessLogicRef {
  id: string;
  token: string;
}

let cache: CacheModule | null = null;
// Upper bound on followed users: covers every user the access and streams
// caches can hold at once. A listener is only dropped by eviction from this
// map (never on a data bust, which would leave the worker deaf for that user
// until its next fill); the cache entries' max age bounds what an evicted
// listener can miss.
const MAX_LISTENERS = 8000;
/**
 * userId -> listener remover
 */
const listenerMap = new LRUCache<string, () => void>({
  max: MAX_LISTENERS,
  dispose: (remove) => { remove(); }
});
const MESSAGES = {
  UNSET_ACCESS_LOGIC: 'unset-access-logic',
  UNSET_USER_DATA: 'unset-user-data',
  UNSET_USER: 'unset-user'
};
// ------- listener
// listen for a userId
function registerListenerForUserId (userId: string): void {
  if (listenerMap.get(userId) != null) { return; } // get() also refreshes recency
  logger.debug('activate listener for user:', userId);
  listenerMap.set(userId, pubsub.cache.onAndGetRemovable(userId, (...args: unknown[]) => {
    handleMessage(userId, args[0] as Message);
  }));
}
// unregister listener
function removeListenerForUserId (userId: string): void {
  logger.debug('disable listener for user:', userId);
  listenerMap.delete(userId); // dispose removes the subscription
}
// listener
function handleMessage (userId: string, msg: Message): void {
  logger.debug('handleMessage', userId, msg);
  if (msg.action === MESSAGES.UNSET_ACCESS_LOGIC) {
    return cache!.unsetAccessLogic(userId, { id: msg.accessId!, token: msg.accessToken! }, false);
  }
  if (msg.action === MESSAGES.UNSET_USER_DATA) {
    // streams and accesses
    return cache!.unsetUserData(userId, false);
  }
  if (msg.action === MESSAGES.UNSET_USER) {
    return handleUnsetUser(msg);
  }
}
function handleUnsetUser (msg: Message): void {
  if (msg.username != null) { cache!.unsetUser(msg.username, false); }
  if (msg.userId != null) { cache!.unsetUserById(msg.userId, false); }
}
// ------- emitter
function unsetAccessLogic (userId: string, accessLogic: AccessLogicRef): void {
  pubsub.cache.emit(userId, {
    action: MESSAGES.UNSET_ACCESS_LOGIC,
    accessId: accessLogic.id,
    accessToken: accessLogic.token
  });
}
function unsetUserData (userId: string): void {
  pubsub.cache.emit(userId, {
    action: MESSAGES.UNSET_USER_DATA
  });
}
// Sent on the channel every process follows, so it reaches workers that hold
// only a name mapping (or only the userId) for this account.
function unsetUser (username: string | null, userId?: string | null): void {
  const msg: Message = { action: MESSAGES.UNSET_USER };
  if (username != null) msg.username = username;
  if (userId != null) msg.userId = userId;
  pubsub.cache.emit(MESSAGES.UNSET_USER, msg);
}
// register cache here (to avoid require cycles)
function setCache (c: CacheModule): void {
  if (cache !== null) {
    return; // cache already set
  }
  cache = c;
  pubsub.cache.on(MESSAGES.UNSET_USER, function (...args: unknown[]) {
    handleUnsetUser(args[0] as Message);
  });
  pubsub.onTransportStateChange((state) => {
    if (state === 'disconnected') {
      cache!.setUntrusted();
    } else {
      cache!.flushAfterReconnect();
    }
  });
}
export {
  registerListenerForUserId,
  unsetAccessLogic,
  unsetUserData,
  unsetUser,
  setCache,
  listenerMap,
  removeListenerForUserId,
  MESSAGES
};

type Message = {
  action: string;
  username?: string;
  userId?: string;
  accessId?: string;
  accessToken?: string;
};
