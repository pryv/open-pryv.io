/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Shared structural types for the CMC plugin modules.

import type { LogFn } from '@pryv/boiler';
// All methods optional: callers use `logger?.warn?.(...)` style throughout.
type CmcLogger = { debug?: LogFn; warn?: LogFn; info?: LogFn; error?: LogFn };

// Outbound HTTP dependency bag (dependency-injected fetch), consumed by
// outbound.postToPeer and threaded through every handler. One declaration —
// previously copied in 7 modules.
type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

type FetchLike = (url: string, init?: FetchInit) => Promise<{
  status: number;
  ok?: boolean;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

type OutboundDeps = {
  fetch: FetchLike;
  timeoutMs?: number;
  logger?: CmcLogger;
};


// ───────────────────── Mall views (DI seams) ─────────────────────
// CMC handlers receive `mall` via dependency injection and are unit-tested
// with simple fakes, so they model narrow promise-based views instead of
// importing the full Mall interface. One shared declaration per group —
// previously re-declared per module with diverging shapes.
// (retryQueue keeps a local specialization: its events flow as RetryEvent.)

/** Counterparty reference as stored in clientData (unverified payload —
 *  all fields optional; the RESOLVED form with required username/host stays
 *  a local type in the modules that produce it). */
export type CounterpartyRef = {
  username?: string;
  host?: string;
  apiEndpoint?: string;
  remoteChatStreamId?: string;
  remoteCollectorStreamId?: string;
};

/** The `clientData.cmc` bag CMC stamps on accesses — union of all fields
 *  the handlers read/write (role decides which subset is present). */
export type CmcClientData = {
  role?: string;
  appCode?: string;
  counterparty?: CounterpartyRef;
  peerAccessId?: string;
  features?: { chat?: boolean; systemMessaging?: boolean; [k: string]: unknown };
  backChannelApiEndpoint?: string;
  capability?: { mode?: string; [k: string]: unknown };
  kind?: string;
  capabilityId?: string;
  requestEventId?: string | null;
  singleUse?: boolean;
};

/** Access as seen through the CMC mall view (mallAccessesAdapter output). */
export type CmcAccessLike = {
  id: string;
  type?: string;
  name?: string;
  token?: string;
  apiEndpoint?: string;
  permissions?: Array<Record<string, unknown>>;
  clientData?: { cmc?: CmcClientData; [k: string]: unknown };
  created?: number;
  createdBy?: string;
  modified?: number;
  modifiedBy?: string;
  expires?: number | null;
};

export type MallParams = Record<string, unknown>;

export type MallAccessesLike = {
  create: (userId: string, params: MallParams) => Promise<CmcAccessLike>;
  get: (userId: string, params?: MallParams) => Promise<CmcAccessLike[]>;
  update: (userId: string, params: MallParams) => Promise<CmcAccessLike | null | undefined>;
  delete: (userId: string, params: MallParams) => Promise<unknown>;
};

export type MallEventsLike = {
  create: (userId: string, params: MallParams) => Promise<{ id?: string; [k: string]: unknown }>;
  get: (userId: string, params?: MallParams) => Promise<Array<Record<string, unknown>>>;
  update: (userId: string, params: MallParams) => Promise<unknown>;
};

export type MallStreamsLike = {
  create: (userId: string, params: MallParams) => Promise<unknown>;
  getOne?: (userId: string, params?: MallParams) => Promise<unknown>;
  delete?: (userId: string, params: MallParams) => Promise<unknown>;
};

/** Full view — modules needing fewer groups compose their own deps type
 *  from the groups above. */
export type MallLike = {
  accesses: MallAccessesLike;
  events: MallEventsLike;
  streams: MallStreamsLike;
};

export type { LogFn, CmcLogger, FetchInit, FetchLike, OutboundDeps };
