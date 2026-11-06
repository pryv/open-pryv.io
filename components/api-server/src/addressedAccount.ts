/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The account a request is addressed to by its host: on a platform with
 * per-user hosts (`https://alice.example.com/...`), the first label of the
 * received `Host`, when it has the username shape and the platform does not
 * answer that name itself (a service host, a core id, a static entry, a hosted
 * site, a runtime DNS record, an issuer label: the predicate the username
 * rewriter uses). Anything else is a platform address and names no account.
 *
 * Read by the adapter ingress (which names the account to the sidecar and
 * answers 421 for an account of another core) and by the OAuth endpoints that
 * must not serve an account of another core on its own host.
 */

import net from 'node:net';
import { USERNAME_REGEXP_STR } from './schema/helpers.ts';

const USERNAME_RE = new RegExp(USERNAME_REGEXP_STR);
// A DNS name (labels of letters, digits and hyphens), an optional final dot,
// an optional port. A Host outside this grammar names no account.
const HOST_RE = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*\.?)(?::(\d{1,5}))?$/;

export type PlatformRoutedLabel = (label: string) => boolean;

/** The received `Host`, lowercased, when it is a DNS name with an optional port; else null. */
export function addressableHost (host: unknown): string | null {
  if (typeof host !== 'string' || host === '') return null;
  const lower = host.toLowerCase();
  const m = HOST_RE.exec(lower);
  if (m == null) return null;
  // An IPv4 literal has the DNS-name shape; it names no account.
  if (net.isIP(m[1]) !== 0) return null;
  return lower;
}

/**
 * The addressed account's name (lowercased, as addressed: a username, an
 * alias or a former username), or null for a platform address.
 */
export function addressedLabelOf (host: unknown, isPlatformRoutedLabel: PlatformRoutedLabel): string | null {
  const h = addressableHost(host);
  if (h == null) return null;
  const hostname = h.replace(/:\d+$/, '');
  const labels = hostname.split('.');
  // A single-label host (`localhost`) is no per-user host.
  if (labels.length < 2 || labels[1] === '') return null;
  const label = labels[0];
  if (!USERNAME_RE.test(label)) return null;
  if (isPlatformRoutedLabel(label)) return null;
  return label;
}
