/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { CmcLogger, OutboundDeps } from './_types.ts';
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
  | { ok: false; reason: 'http-5xx'; status: number; body: unknown }
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
    if (res.status >= 400 && res.status < 500) {
      deps.logger?.debug?.('cmc/outbound: peer rejected delivery', { host: base, status: res.status });
      return { ok: false, reason: 'http-4xx', status: res.status, body: parsed };
    }
    deps.logger?.warn?.('cmc/outbound: peer 5xx', { host: base, status: res.status });
    return { ok: false, reason: 'http-5xx', status: res.status, body: parsed };
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
 * Classify a DeliverResult into retry-policy categories.
 */
function isRetryableFailure (r: DeliverResult): boolean {
  if (r.ok) return false;
  // 4xx is non-retryable (the peer rejected with a permanent reason).
  if (r.reason === 'http-4xx') return false;
  // A refused destination stays refused.
  if (r.reason === 'refused') return false;
  // Everything else (5xx, network, timeout) is retryable.
  return true;
}

export {
  DEFAULT_TIMEOUT_MS,
  parseApiEndpoint,
  stripCredentials,
  postToPeer,
  requestPeer,
  isRetryableFailure,
};
export type { DeliverResult };
