/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: a client's public JWK Set published at its `jwks_uri` (RFC 7591
 * §2), fetched to verify its `private_key_jwt` assertions.
 *
 * The URL is registered by the operator but served by the client, so the
 * fetch goes through `peerFetch` (the counterparty client): a loopback,
 * private, link-local or reserved address is refused before any socket
 * connects (`cmc.allowedPrivateHosts` lists the exceptions), a host name is
 * resolved with a checked lookup pinned to the connection, redirects are not
 * followed. On top of that: `https:` only (whatever
 * `cluster.allowInsecurePeerUrl` says), a 200 answer only, a 64 KiB body cap,
 * a 5 second timeout. As for every counterparty call, the platform's own host
 * names (`core.url`'s host, `dns.domain` and below, the `service.api` host)
 * are trusted by name, without the address check.
 *
 * Cache, per URL, in memory on each core: a fetched set is used for 5
 * minutes (while the URL answers, a key the client withdraws stops verifying
 * within that time); concurrent misses share one fetch; at most 256 URLs are
 * kept (oldest dropped). An assertion naming a `kid` the cached set does not
 * hold refreshes the set once, at most every 30 seconds per URL (a client
 * rotating its key). A failed fetch never drops a set already fetched: the
 * last set stays in use and the URL is retried 30 seconds later. Only a URL
 * never fetched (or fallen out of the cache) is refused while it fails, and
 * that failure is remembered for 30 seconds, so assertions naming the client
 * cannot make this core call it on every request.
 */

import { peerFetch } from 'business/src/outbound/peerFetch.ts';
import { usablePublicJwkSet, type PublicJwkSet } from './jwks.ts';
import { logServerWarning } from './serverLog.ts';

export const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
export const JWKS_FAILURE_TTL_MS = 30 * 1000;
export const JWKS_REFRESH_MIN_INTERVAL_MS = 30 * 1000;
export const MAX_JWKS_RESPONSE_BYTES = 64 * 1024;
const MAX_CACHED_URLS = 256;
const FETCH_TIMEOUT_MS = 5000;
const MAX_URL_LENGTH = 2048;

/** Why a `jwks_uri` cannot be registered or fetched, or null. */
export function jwksUriProblem (uri: unknown): string | null {
  if (typeof uri !== 'string' || uri.length === 0) return 'jwks_uri must be a non-empty string';
  if (uri.length > MAX_URL_LENGTH) return `jwks_uri is longer than ${MAX_URL_LENGTH} characters`;
  let u: URL;
  try { u = new URL(uri); } catch { return 'jwks_uri is not a valid URL'; }
  if (u.protocol !== 'https:') return 'jwks_uri must be an https URL';
  if (u.username !== '' || u.password !== '') return 'jwks_uri must not carry credentials';
  if (u.hash !== '') return 'jwks_uri must not carry a fragment';
  return null;
}

/** A `jwks_uri` that could not be used; `reason` stays server-side. */
export class JwksFetchError extends Error {
  readonly reason: string;
  constructor (reason: string) {
    super('client JWK Set unavailable');
    this.reason = reason;
  }
}

type CacheEntry = { keys: PublicJwkSet | null; reason: string | null; fetchedAt: number; expiresAt: number };

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<PublicJwkSet>>();

function remember (uri: string, entry: CacheEntry): void {
  cache.delete(uri);
  cache.set(uri, entry);
  while (cache.size > MAX_CACHED_URLS) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    cache.delete(oldest);
  }
}

/**
 * The usable public keys published at `uri`, from the cache when fresh.
 * `unknownKid`: the caller's assertion named a key the set does not hold;
 * the set is fetched again when the cached one is old enough. A failed fetch
 * keeps the last set fetched, if any (retried 30 seconds later); throws
 * JwksFetchError only when no set was ever fetched (or it fell out of the
 * cache).
 */
export async function getClientJwks (
  uri: string, opts: { unknownKid?: boolean; now?: number } = {}
): Promise<PublicJwkSet> {
  const problem = jwksUriProblem(uri);
  if (problem != null) throw new JwksFetchError(problem);
  const now = opts.now ?? Date.now();
  const entry = cache.get(uri);
  if (entry != null && now < entry.expiresAt) {
    const refresh = opts.unknownKid === true && entry.keys != null && now - entry.fetchedAt >= JWKS_REFRESH_MIN_INTERVAL_MS;
    if (!refresh) {
      if (entry.keys != null) return entry.keys;
      throw new JwksFetchError(entry.reason ?? 'fetch failed recently');
    }
  }
  let pending = inflight.get(uri);
  if (pending == null) {
    pending = fetchJwks(uri).then(
      (keys) => {
        remember(uri, { keys, reason: null, fetchedAt: now, expiresAt: now + JWKS_CACHE_TTL_MS });
        return keys;
      },
      (err: unknown) => {
        const reason = err instanceof JwksFetchError ? err.reason : String((err as Error)?.message ?? err);
        // Logged here, once per fetch (concurrent callers share this promise).
        const last = cache.get(uri)?.keys ?? null;
        if (last != null) {
          // A failed re-fetch (expiry, or a probe naming an unknown kid) must
          // not lock the client out: the last set fetched stays in use.
          logServerWarning(`jwks_uri ${uri} unusable: ${reason}; the last key set fetched stays in use, retried in 30 s`);
          remember(uri, { keys: last, reason: null, fetchedAt: now, expiresAt: now + JWKS_FAILURE_TTL_MS });
          return last;
        }
        logServerWarning(`jwks_uri ${uri} unusable: ${reason}`);
        remember(uri, { keys: null, reason, fetchedAt: now, expiresAt: now + JWKS_FAILURE_TTL_MS });
        throw err instanceof JwksFetchError ? err : new JwksFetchError(reason);
      }
    ).finally(() => { inflight.delete(uri); });
    inflight.set(uri, pending);
  }
  return await pending;
}

async function fetchJwks (uri: string): Promise<PublicJwkSet> {
  let res: Response;
  try {
    res = await peerFetch(uri, {
      method: 'GET',
      headers: { accept: 'application/jwk-set+json, application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'manual',
    });
  } catch (err: unknown) {
    const e = err as { code?: string; kind?: string; message?: string } | null;
    throw new JwksFetchError(e?.code === 'EPEERREFUSED' ? 'refused: ' + e.kind : 'fetch failed: ' + (e?.message ?? String(err)));
  }
  // Only a 200: a redirect (3xx) is never followed, whatever the transport.
  if (res.status !== 200) throw new JwksFetchError('HTTP status ' + res.status);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_JWKS_RESPONSE_BYTES) throw new JwksFetchError('response too large');
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_JWKS_RESPONSE_BYTES) throw new JwksFetchError('response too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new JwksFetchError('response is not JSON');
  }
  try {
    return usablePublicJwkSet(parsed);
  } catch (err: unknown) {
    throw new JwksFetchError((err as Error).message);
  }
}

/** Tests: forget every cached set. */
export function resetJwksCacheForTests (): void {
  cache.clear();
  inflight.clear();
}
