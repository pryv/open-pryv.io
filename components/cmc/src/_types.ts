/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Shared structural types for the CMC plugin modules.

type LogFn = (...args: unknown[]) => void;
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
  [k: string]: unknown;
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

export type { LogFn, CmcLogger, FetchInit, FetchLike, OutboundDeps };
