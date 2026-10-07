/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Rules for core ids and core-to-core URLs.
 *
 * A core id becomes a DNS label (`<id>.<domain>`) and the host of derived core
 * URLs, and core URLs receive the admin key on cross-core calls. Both come
 * from config and from platform rows, so they are checked when written and
 * again before use.
 */

/** A core id: one lowercase DNS label. */
export const CORE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Budget for one core-to-core request. */
export const PEER_FETCH_TIMEOUT_MS = 10000;

export function isValidCoreId (id: unknown): id is string {
  return typeof id === 'string' && CORE_ID_PATTERN.test(id);
}

/** Why `id` is not a valid core id, or null when it is. */
export function coreIdProblem (id: unknown): string | null {
  if (isValidCoreId(id)) return null;
  return `core id ${JSON.stringify(id)} is invalid: use 1 to 63 lowercase letters, digits or '-', starting with a letter or digit`;
}

export type PeerUrlOptions = {
  /** Accept `http:` (development and test clusters only). */
  allowInsecure?: boolean;
};

/**
 * Why `url` cannot be used as a core URL, or null when it can. A core URL is
 * an origin: `https://host[:port]` with an optional trailing `/`, no
 * credentials, path, query or fragment. `http:` only with `allowInsecure`.
 */
export function peerUrlProblem (url: unknown, opts: PeerUrlOptions = {}): string | null {
  if (typeof url !== 'string' || url.length === 0) return 'core URL is missing';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `core URL ${JSON.stringify(url)} is not a valid URL`;
  }
  const label = `core URL ${JSON.stringify(url)}`;
  if (parsed.protocol === 'http:') {
    if (opts.allowInsecure !== true) {
      return `${label} uses http: (core-to-core calls carry the admin key); use https:, or set cluster.allowInsecurePeerUrl: true on a development or test cluster`;
    }
  } else if (parsed.protocol !== 'https:') {
    return `${label} must use https:`;
  }
  if (parsed.username !== '' || parsed.password !== '') return `${label} must not carry credentials`;
  if (parsed.pathname !== '/' && parsed.pathname !== '') return `${label} must not carry a path`;
  if (parsed.search !== '' || url.includes('?')) return `${label} must not carry a query`;
  if (parsed.hash !== '' || url.includes('#')) return `${label} must not carry a fragment`;
  return null;
}

export function isValidPeerUrl (url: unknown, opts: PeerUrlOptions = {}): url is string {
  return peerUrlProblem(url, opts) == null;
}

/** `cluster.allowInsecurePeerUrl` from a boiler-style config (`get('a:b')`). */
export function insecurePeerUrlAllowed (config: { get: (key: string) => unknown } | null | undefined): boolean {
  return config != null && config.get('cluster:allowInsecurePeerUrl') === true;
}

/**
 * Options for a core-to-core `fetch`: bounded in time, and never follows a
 * redirect (a redirect would resend the request, and its credentials, to a
 * host nobody configured).
 */
export function peerFetchOptions<T extends Record<string, unknown>> (init: T, timeoutMs: number = PEER_FETCH_TIMEOUT_MS): T & { signal: AbortSignal; redirect: 'error' } {
  return { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' };
}
