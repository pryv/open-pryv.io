/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The account a request is addressed to by its host: on a platform with
 * per-user hosts (`https://alice.example.com/...`), a host exactly one label
 * under `dns.domain`, when that label has the username shape, is not
 * `adapter` and the platform does not answer that name itself (a service
 * host, a core id, a static entry, a hosted site, a runtime DNS record, an
 * issuer label: the predicate the username rewriter uses). Anything else is a
 * platform address and names no account: another domain, a deeper host, the
 * domain itself, an IP, a single label.
 *
 * Read by the adapter ingress (which names the account to the sidecar and
 * answers 421 for an account of another core) and by the OAuth endpoints that
 * must not serve an account of another core on its own host.
 */

import net from 'node:net';
import { USERNAME_REGEXP_STR } from './schema/helpers.ts';
import { usernameInHost } from 'business/src/usernameSubdomains.ts';
import { platformRoutedLabels } from './platformLabels.ts';
import type { UserCorePlatform } from './routes/reg/userCore.ts';

const USERNAME_RE = new RegExp(USERNAME_REGEXP_STR);
// A DNS name (labels of letters, digits and hyphens), an optional final dot,
// an optional port. A Host outside this grammar names no account.
const HOST_RE = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*)(\.?)(?::(\d{1,5}))?$/;

const DEFAULT_RETRY_AFTER_SECONDS = 300;

export type PlatformRoutedLabel = (label: string) => boolean;
type ConfigReader = { get: (key: string) => unknown };
type WarnLogger = { warn: (msg: string) => void };

/**
 * How per-user hosts are read: the platform-routed-labels predicate, the
 * platform's domain, the `Retry-After` of a wrong-core answer, and for tests
 * the platform slice the placement lookup uses (the singleton otherwise).
 */
export type PerUserAddressing = {
  isPlatformRoutedLabel: PlatformRoutedLabel;
  domain: string;
  retryAfterSeconds?: number;
  platform?: UserCorePlatform;
};

/**
 * The received `Host`, lowercased, without a final dot (port kept), when it is
 * a DNS name with an optional port; else null.
 */
export function addressableHost (host: unknown): string | null {
  if (typeof host !== 'string' || host === '') return null;
  const m = HOST_RE.exec(host.toLowerCase());
  if (m == null) return null;
  // An IPv4 literal has the DNS-name shape; it names no account.
  if (net.isIP(m[1]) !== 0) return null;
  return m[1] + (m[3] != null ? ':' + m[3] : '');
}

function normalisedDomain (domain: unknown): string | null {
  if (typeof domain !== 'string') return null;
  const d = domain.trim().toLowerCase().replace(/\.$/, '');
  return d === '' ? null : d;
}

/**
 * The addressed account's name (lowercased, as addressed: a username, an
 * alias or a former username), or null for a platform address.
 */
export function addressedLabelOf (host: unknown, isPlatformRoutedLabel: PlatformRoutedLabel, domain: unknown): string | null {
  const d = normalisedDomain(domain);
  if (d == null) return null;
  const h = addressableHost(host);
  if (h == null) return null;
  const hostname = h.replace(/:\d+$/, '');
  if (!hostname.endsWith('.' + d)) return null;
  const label = hostname.slice(0, hostname.length - d.length - 1);
  if (label === '' || label.includes('.')) return null;
  if (!USERNAME_RE.test(label)) return null;
  // No account is named `adapter` (registration and the adapter routes' boot
  // check refuse it): that host is a platform address.
  if (label === 'adapter') return null;
  if (isPlatformRoutedLabel(label)) return null;
  return label;
}

/** `dns.defaultTTL` (the lifetime of the DNS answer a client may still hold), in seconds. */
export function retryAfterSeconds (config: ConfigReader): number {
  const ttl = Number(config.get('dns:defaultTTL'));
  return Number.isInteger(ttl) && ttl > 0 ? ttl : DEFAULT_RETRY_AFTER_SECONDS;
}

/**
 * The per-user address reading of a configuration: on a platform with
 * per-user hosts and a `dns.domain`, the username rewriter's predicate and
 * that domain; null in dnsLess mode (the host is the core's own name, never
 * an account) and without `dns.domain` (then `logger`, when given, is warned).
 */
export function perUserAddressingFor (config: ConfigReader, logger?: WarnLogger): PerUserAddressing | null {
  if (!usernameInHost(config)) return null;
  const domain = normalisedDomain(config.get('dns:domain'));
  if (domain == null) {
    logger?.warn('adapter routes: per-user addresses need dns.domain; every host is a platform address');
    return null;
  }
  return { isPlatformRoutedLabel: platformRoutedLabels(config), domain, retryAfterSeconds: retryAfterSeconds(config) };
}
