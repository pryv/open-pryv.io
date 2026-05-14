/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — public entry point. Re-exports namespace constants, slug
 * helpers, content validators, write-hook factories, auto-provisioning.
 */

const constants = require('./constants.ts');
const slug = require('./slug.ts');
const validators = require('./validators.ts');
const hooks = require('./hooks.ts');
const provisioning = require('./provisioning.ts');
const outbound = require('./outbound.ts');
const capability = require('./capability.ts');
const acceptOrchestration = require('./acceptOrchestration.ts');
const handleAccept = require('./handleAccept.ts');
const dispatch = require('./dispatch.ts');
const chatOrchestration = require('./chatOrchestration.ts');
const capabilityMintHook = require('./capabilityMintHook.ts');
const inboxWriteHook = require('./inboxWriteHook.ts');
const rateLimit = require('./rateLimit.ts');
const handleSystem = require('./handleSystem.ts');
const handleChat = require('./handleChat.ts');
const handleRevoke = require('./handleRevoke.ts');

export {
  constants, slug, validators, hooks, provisioning,
  outbound, capability, acceptOrchestration, handleAccept, dispatch,
  chatOrchestration, capabilityMintHook, inboxWriteHook, rateLimit,
  handleSystem, handleChat, handleRevoke,
};

export const { RateLimiter } = rateLimit;

export const { createCapabilityMintHook } = capabilityMintHook;
export const { createInboxWriteHook } = inboxWriteHook;

export const { createDispatchMiddleware } = dispatch;

// Hook factories at top-level for api-server integration.
export const {
  createCmcContentValidationHook,
  createStreamCreateReservedRootHook,
} = hooks;

// Provisioning at top-level for users/repository.ts integration.
export const {
  provisionUserStreams,
  RESERVED_TREE,
} = provisioning;

// Flat constants re-exports for convenience.
export const {
  NS,
  NS_INBOX,
  NS_APPS,
  NS_INTERNAL,
  NS_INTERNAL_RETRIES,
  RESERVED_PARENT_STREAM_IDS,
  USER_CREATABLE_PARENT_STREAM_ID,
  APP_RESERVED_SEGMENTS,
  chatsParentUnder,
  chatStreamUnder,
  collectorsParentUnder,
  collectorStreamUnder,
  offerStreamIdFor,
  responsesStreamIdFor,
  isCmcStreamId,
  isAppNestedPluginStream,
  isUserCreatableStreamId,
  isPluginManagedStreamId,
  getAppCode,
  ET_REQUEST,
  ET_ACCEPT,
  ET_REFUSE,
  ET_REVOKE,
  ET_CHAT,
  ET_SYSTEM_ALERT,
  ET_SYSTEM_ACK,
  ET_SYSTEM_SCOPE_REQUEST,
  ET_SYSTEM_SCOPE_UPDATE,
  ET_RETRY,
  EVENT_TYPES_LIFECYCLE,
  EVENT_TYPES_CHAT,
  EVENT_TYPES_SYSTEM,
  ALL_EVENT_TYPES,
} = constants;
