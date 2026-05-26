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
const handleSystem = require('./handleSystem.ts');
const handleChat = require('./handleChat.ts');
const handleRevoke = require('./handleRevoke.ts');
const handleInvalidateLink = require('./handleInvalidateLink.ts');
const retryQueue = require('./retryQueue.ts');
const handleIncomingAccept = require('./handleIncomingAccept.ts');
const anchorStreams = require('./anchorStreams.ts');
const accessesUpdateHook = require('./accessesUpdateHook.ts');
const retryScheduler = require('./retryScheduler.ts');
const bootRetryLoop = require('./bootRetryLoop.ts');
const mallAccessesAdapter = require('./mallAccessesAdapter.ts');
const errorIds = require('./errorIds.ts');
const capabilityResponseHook = require('./capabilityResponseHook.ts');

export {
  constants, slug, validators, hooks, provisioning,
  outbound, capability, acceptOrchestration, handleAccept, dispatch,
  chatOrchestration, capabilityMintHook, inboxWriteHook,
  handleSystem, handleChat, handleRevoke, handleInvalidateLink, retryQueue, handleIncomingAccept,
  anchorStreams, accessesUpdateHook, retryScheduler, bootRetryLoop,
  mallAccessesAdapter, errorIds, capabilityResponseHook,
};
export const CmcErrorIds = errorIds.CmcErrorIds;
export const { createCapabilityResponseHook } = capabilityResponseHook;

export const { createAccessesUpdatePostHook, runWithSuppression } = accessesUpdateHook;
export const { RetryScheduler } = retryScheduler;
export const { startRetryLoopIfEnabled } = bootRetryLoop;
export const { createMallAccessesAdapter } = mallAccessesAdapter;

export const { createCapabilityMintHook, createCapabilityPostCreateHook } = capabilityMintHook;
export const { createInboxWriteHook } = inboxWriteHook;

export const { createDispatchMiddleware } = dispatch;

// Hook factories at top-level for api-server integration.
export const {
  createCmcContentValidationHook,
  createStreamCreateReservedRootHook,
  createStreamDeleteReservedRootHook,
  createEnsureReservedParentsHook,
  createCounterpartyFromStampingHook,
  createAccessCreateForgePreventionHook,
  createAccessUpdateForgePreventionHook,
  createAccessProvisionAppScopeHook,
  extractAppScopeLeavesToProvision,
  createEventsGetInternalGuardHook,
  createEventGetOneInternalGuardHook,
  createStreamsGetInternalGuardHook,
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
  isCmcInternalStreamId,
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
  ET_INVALIDATE_LINK,
  EVENT_TYPES_LIFECYCLE,
  EVENT_TYPES_CHAT,
  EVENT_TYPES_SYSTEM,
  EVENT_TYPES_CAPABILITY,
  ALL_EVENT_TYPES,
} = constants;
