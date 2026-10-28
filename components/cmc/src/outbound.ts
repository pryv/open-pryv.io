/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { OutboundDeps } from './_types.ts';
const require = createRequire(import.meta.url);
const { withoutUrlUserinfo } = require('business/src/accesses/credentialUrls.ts');

/**
 * Outbound HTTPS client.
 *
 * Federated cross-platform / cross-core delivery to counterparty apiEndpoints.
 *
 * apiEndpoint shape (Pryv standard): `https://<token>@<host>[:<port>][/]`.
 * The token in the URL is the access token; HTTPS to that host is auth'd
 * via the token (no mTLS, no shared CA — see README.md "Future development
 * scoping"). Same code path for cross-core same-platform AND cross-platform.
 *
 * Pure module: takes `fetch` and timeouts via deps so tests can inject a
 * fake. Returns `{ ok, status, body? }` discriminated unions per outcome.
 */

type DeliverResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; reason: 'http-4xx'; status: number; body: unknown }
  // 408 (Request Timeout) or 429 (Too Many Requests): the peer, or a proxy in
  // front of it, asks to be called again later. Retryable, unlike every other
  // 4xx; `retryAfterMs` is its Retry-After header, when it sent a valid one.
  | { ok: false; reason: 'http-retry-later'; status: number; body: unknown; retryAfterMs?: number }
  // Retryable. A 503 may carry the peer's Retry-After (maintenance, overload).
  | { ok: false; reason: 'http-5xx'; status: number; body: unknown; retryAfterMs?: number }
  | { ok: false; reason: 'network'; status: 0; error: string }
  | { ok: false; reason: 'timeout'; status: 0 }
  // The destination may not be called (private or reserved address, http,
  // redirect, oversized answer): permanent, never retried.
  | { ok: false; reason: 'refused'; status: 0; kind: string; host: string };

/**
 * Parse a Pryv apiEndpoint URL into (token, base) where `base` is suitable
 * for path-appending and `token` becomes the `Authorization` header value.
 *
 * Example: `https://AbCxYz@example.com/` →
 *   { token: 'AbCxYz', base: 'https://example.com/' }
 *
 * The trailing slash is preserved on `base` so callers can append paths
 * directly: `base + 'events'` → `https://example.com/events`.
 *
 * Throws if the URL doesn't carry a token (no `@` in authority).
 */
function parseApiEndpoint (apiEndpoint: string): { token: string; base: string } {
  if (typeof apiEndpoint !== 'string' || apiEndpoint.length === 0) {
    throw new Error('cmc/outbound: apiEndpoint must be a non-empty string');
  }
  const url = new URL(apiEndpoint);
  if (url.username === '' && url.password === '') {
    throw new Error('cmc/outbound: apiEndpoint must carry a token in the URL authority');
  }
  // Pryv apiEndpoints put the token as the URL username (no password).
  const token = url.username || url.password;
  const stripped = new URL(url.toString());
  stripped.username = '';
  stripped.password = '';
  // URL serializes without trailing slash sometimes; preserve the user's intent.
  let base = stripped.toString();
  if (!base.endsWith('/')) base += '/';
  return { token, base };
}

/**
 * The same URL without its `user:password@` part — that is, an apiEndpoint
 * with its token removed. Returned unchanged when it does not parse.
 *
 * Use this before an apiEndpoint is written anywhere durable that is not
 * meant to hand out a credential: an event in a user stream apps can be
 * granted, a delivery to a peer that has no use for the token, a log line.
 * What survives (scheme, host, path) still identifies WHICH endpoint is
 * meant, which is all a bookkeeping record needs.
 */
function stripCredentials (url: string): string {
  return withoutUrlUserinfo(url);
}

/**
 * Default timeout for an outbound delivery (per-attempt, not cumulative).
 * 15s matches the operator-side expectation that cross-platform deliveries
 * are bounded but tolerate transient latency.
 */
const DEFAULT_TIMEOUT_MS = 15 * 1000;

/**
 * POST a JSON body to a Pryv API method on the counterparty's platform.
 *
 *   path: e.g. 'events', 'streams', 'accesses' (no leading slash).
 *   body: serializable object.
 *
 * Returns a discriminated union — no exceptions thrown for HTTP error codes.
 * Network and timeout failures also return as failure variants.
 */
async function postToPeer (params: {
  apiEndpoint: string;
  path: string;
  body: unknown;
  deps: OutboundDeps;
}): Promise<DeliverResult> {
  return requestPeer({ ...params, method: 'POST' });
}

/**
 * Call a Pryv API method on the counterparty's platform with any method
 * (`GET` / `DELETE` carry no body). Same contract as `postToPeer`, which is
 * the `POST` case. Used by the group-account mint and sweep, which read,
 * create and delete accesses on a patient's core through the consent grant.
 */
async function requestPeer (params: {
  apiEndpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  deps: OutboundDeps;
}): Promise<DeliverResult> {
  const { apiEndpoint, method, path, body, deps } = params;
  const { token, base } = parseApiEndpoint(apiEndpoint);
  const url = base + path;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (controller != null) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const headers: Record<string, string> = { authorization: token };
    const init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal } = {
      method,
      headers,
      signal: controller?.signal,
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await deps.fetch(url, init);

    if (timer != null) clearTimeout(timer);

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (_e) {
      parsed = null;
    }

    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status, body: parsed };
    }
    if (RETRY_LATER_STATUSES.has(res.status)) {
      const retryAfterMs = parseRetryAfter(res.headers?.get?.('retry-after') ?? null, Date.now());
      deps.logger?.warn?.('cmc/outbound: peer asks to retry later', { host: base, status: res.status, retryAfterMs });
      return retryAfterMs == null
        ? { ok: false, reason: 'http-retry-later', status: res.status, body: parsed }
        : { ok: false, reason: 'http-retry-later', status: res.status, body: parsed, retryAfterMs };
    }
    if (res.status >= 400 && res.status < 500) {
      deps.logger?.debug?.('cmc/outbound: peer rejected delivery', { host: base, status: res.status });
      return { ok: false, reason: 'http-4xx', status: res.status, body: parsed };
    }
    const retryAfterMs5xx = res.status === 503
      ? parseRetryAfter(res.headers?.get?.('retry-after') ?? null, Date.now())
      : null;
    deps.logger?.warn?.('cmc/outbound: peer 5xx', { host: base, status: res.status, retryAfterMs: retryAfterMs5xx });
    return retryAfterMs5xx == null
      ? { ok: false, reason: 'http-5xx', status: res.status, body: parsed }
      : { ok: false, reason: 'http-5xx', status: res.status, body: parsed, retryAfterMs: retryAfterMs5xx };
  } catch (err) {
    if (timer != null) clearTimeout(timer);
    const errObj = err as { name?: string; code?: string; message?: string; kind?: string; host?: string } | null;
    // A guarded fetch refusing the destination (business/src/outbound/peerFetch.ts).
    if (errObj?.code === 'EPEERREFUSED') {
      const refused = { kind: String(errObj.kind ?? 'address'), host: String(errObj.host ?? '') };
      deps.logger?.warn?.('cmc/outbound: delivery refused', { ...refused, hint: 'cmc.allowedPrivateHosts lists private peers that may be called' });
      return { ok: false, reason: 'refused', status: 0, ...refused };
    }
    const isAbort = errObj?.name === 'AbortError' || errObj?.code === 'ABORT_ERR';
    if (isAbort) {
      deps.logger?.warn?.('cmc/outbound: timeout', { host: base, timeoutMs });
      return { ok: false, reason: 'timeout', status: 0 };
    }
    deps.logger?.warn?.('cmc/outbound: network failure', { host: base, error: String(err) });
    return { ok: false, reason: 'network', status: 0, error: String(errObj?.message || err) };
  }
}

/**
 * The 4xx answers that are not the peer's verdict on the request but a
 * "not now": a rate limiter (429) or a proxy that gave up waiting (408).
 */
const RETRY_LATER_STATUSES = new Set([408, 429]);

/**
 * A Retry-After header value (RFC 9110: delay-seconds or an HTTP-date) as a
 * delay in ms from `now`; null when absent or unreadable. A date in the past
 * reads as 0.
 */
function parseRetryAfter (value: string | null | undefined, now: number): number | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v === '') return null;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  // An HTTP-date (any of its three RFC 9110 forms) starts with the weekday;
  // Date.parse alone would read a bare number such as "-5" as a year.
  if (!/^[A-Za-z]{3}/.test(v)) return null;
  // The asctime form ends with the year and carries no zone, but means GMT;
  // Date.parse would read it as local time.
  const at = Date.parse(/\d{4}$/.test(v) ? v + ' GMT' : v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/**
 * Classify a DeliverResult into retry-policy categories.
 */
function isRetryableFailure (r: DeliverResult): boolean {
  if (r.ok) return false;
  // 4xx is non-retryable (the peer rejected with a permanent reason), except
  // 408 / 429 (reason 'http-retry-later'), which ask to come back later.
  if (r.reason === 'http-4xx') return false;
  // A refused destination stays refused.
  if (r.reason === 'refused') return false;
  // Everything else (408 / 429, 5xx, network, timeout) is retryable.
  return true;
}

/**
 * A 403 `invalid-access-token` (a 401 with that id is read the same way) to a revoke notice means
 * the access the notice is sent through is gone: the peer already tore the
 * relationship down (a notice delivered twice, or the peer revoked first).
 * That is the end state the notice exists to produce. Takes a raw result
 * (`body`) or a delivery verdict (`errorId`).
 */
function isPeerAccessGone (r: { status?: number; errorId?: string; body?: unknown }): boolean {
  const errorId = r.errorId ?? (r.body as { error?: { id?: unknown } } | null | undefined)?.error?.id;
  return (r.status === 401 || r.status === 403) && errorId === 'invalid-access-token';
}

/**
 * The peer's Retry-After of a failed result, in ms, when it sent one (a 408 /
 * 429, or a 503).
 */
function retryAfterOf (r: { reason?: string; retryAfterMs?: number } | null | undefined): number | undefined {
  if (r == null || (r.reason !== 'http-retry-later' && r.reason !== 'http-5xx')) return undefined;
  const ms: unknown = r.retryAfterMs;
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

export {
  DEFAULT_TIMEOUT_MS,
  RETRY_LATER_STATUSES,
  parseRetryAfter,
  retryAfterOf,
  parseApiEndpoint,
  stripCredentials,
  postToPeer,
  requestPeer,
  isRetryableFailure,
  isPeerAccessGone,
};
export type { DeliverResult };
