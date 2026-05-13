/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Plan 68 — Cross-account Messaging & Consent (CMC) plugin.
 *
 * Public entry point. Re-exports namespace + event-type constants,
 * slug helpers, and (as later phases land) write-hook factories,
 * validators, and orchestration services.
 */

const constants = require('./constants.ts');
const slug = require('./slug.ts');
const validators = require('./validators.ts');
const hooks = require('./hooks.ts');

export { constants, slug, validators, hooks };

// Re-export hook factories at the top level for api-server integration.
export const {
  createCmcContentValidationHook,
  createStreamCreateReservedRootHook,
} = hooks;

// Re-export constants flat for convenience: `require('cmc').NS_INBOX`.
export const {
  NS,
  NS_INBOX,
  NS_CHATS,
  NS_COLLECTORS,
  NS_APPS,
  NS_INTERNAL,
  NS_INTERNAL_RETRIES,
  RESERVED_PARENT_STREAM_IDS,
  USER_CREATABLE_PARENT_STREAM_ID,
  chatStreamIdFor,
  collectorStreamIdFor,
  offerStreamIdFor,
  responsesStreamIdFor,
  isCmcStreamId,
  isPluginManagedStreamId,
  isUserCreatableStreamId,
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
