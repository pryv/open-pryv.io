/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * Account-delegation plugin — public entry point. Re-exports namespace
 * constants, the typed error-id catalogue, and the guard-hook factories.
 */

import * as constants from './constants.ts';
import * as hooks from './hooks.ts';
import * as errorIds from './errorIds.ts';

export { constants, hooks, errorIds };

export const DelegationErrorIds = errorIds.DelegationErrorIds;

// Hook factories at top-level for api-server integration.
export const {
  createAccessCreateForgePreventionHook,
  createAccessUpdateForgePreventionHook,
  createAccessesDeleteGuardHook,
  createAccessesUpdateGuardHook,
  createStreamCreateReservedRootHook,
  createStreamDeleteReservedRootHook,
  createEventsWriteGuardHook,
  createEventsDeleteGuardHook,
  createEventsUpdateGuardHook,
} = hooks;

// Flat constants re-exports for convenience.
export const {
  NS,
  NS_INTERNAL,
  RESERVED_PARENT_STREAM_IDS,
  delegatesStreamId,
  controlledStreamId,
  responsesStreamIdFor,
  notifyStreamIdFor,
  ctlStreamIdFor,
  isDelegationStreamId,
  isDelegationInternalStreamId,
  ET_PREFIX,
  ET_ANCHOR,
  ET_MIRROR,
  ALL_EVENT_TYPES,
  isDelegationEventType,
  CLIENTDATA_KIND,
  STATUS,
} = constants;
