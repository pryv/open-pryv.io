/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The host this core presents to a counterparty as its identity (CMC
 * relationships, delegations, OAuth revoke notices). Peers match on it, so
 * every path must derive it the same way.
 *
 * Priority order: `dns:domain` (multi-core deploys serve from
 * `<id>.<domain>`; the bare domain is the counterparty-facing identity); the
 * host of `service:api` or `service:register` (a real URL); the host of
 * `core:url` (a dnsLess core configured with `core.url` but no
 * `dnsLess.publicUrl` has no `service` block); `localhost` as the last-resort
 * dev fallback. `service:name` is a human label, never a host.
 *
 * A `{username}` placeholder is replaced by `username` when given, else by
 * `x`, so the URL parses.
 */
function selfIdentityHost (config: { get: (k: string) => unknown }, username?: string): string {
  const sub = (v: string): string => v.replace('{username}', username ?? 'x');
  const dnsDomain = config.get('dns:domain');
  if (typeof dnsDomain === 'string' && dnsDomain.length > 0) return sub(dnsDomain);
  for (const key of ['service:api', 'service:register', 'core:url']) {
    const url = config.get(key);
    if (typeof url === 'string' && url.length > 0) {
      try { return new URL(sub(url)).host; } catch { /* try next */ }
    }
  }
  return 'localhost';
}

export { selfIdentityHost };
