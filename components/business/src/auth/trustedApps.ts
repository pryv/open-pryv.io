/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * `auth.trustedApps`: which app ids may drive the browser login and
 * password-reset flows, and from which origins.
 *
 * Setting: comma-separated `<appId>@<origin pattern>` entries.
 * - `<appId>` is an exact app id, or `*` for any app id.
 * - `<origin pattern>` is `*` (any origin, including none), or
 *   `<scheme>://<host>[:<port>]`, matched as an origin: scheme, host and port
 *   are compared separately, paths never matter.
 *   - The host may start with a whole `*.` label: `https://*.example.com`
 *     matches any subdomain of example.com (not example.com itself).
 *     A `*` anywhere else in the host is refused.
 *   - `:*` as the port matches any port on that host.
 *   - A trailing `*` (legacy form, e.g. `https://*.example.com*`) is accepted:
 *     right after the host it means any port, after a port or a path it adds
 *     nothing. It never extends the host: `https://x.example.com.other.net`
 *     does not match `https://*.example.com*`.
 *
 * The request origin is the `Origin` header, or the `Referer` header reduced
 * to its origin.
 */

type OriginPattern =
  | { any: true }
  | { any: false; protocol: string; host: string; subdomainsOf: boolean; port: string | null };

export type TrustedApp = { appId: string; origin: OriginPattern };

const ENTRY_RE = /^\s*(\S+)\s*@\s*(\S+)\s*$/;
const ENDS_AT_AUTHORITY_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+$/i;
const EXPLICIT_PORT_RE = /:\d+$/;

/** Parse the setting; invalid entries are left out and described in `errors`. */
export function parseTrustedApps (setting: unknown): { apps: TrustedApp[]; errors: string[] } {
  const apps: TrustedApp[] = [];
  const errors: string[] = [];
  if (typeof setting !== 'string') return { apps, errors: ['the setting must be a string'] };
  for (const raw of setting.split(',')) {
    if (raw.trim() === '') continue;
    const parts = ENTRY_RE.exec(raw);
    if (parts == null) {
      errors.push(`'${raw.trim()}' is not of the form <appId>@<origin>`);
      continue;
    }
    const origin = parseOriginPattern(parts[2]);
    if (typeof origin === 'string') {
      errors.push(`'${raw.trim()}': ${origin}`);
      continue;
    }
    apps.push({ appId: parts[1], origin });
  }
  return { apps, errors };
}

/** Whether `appId` coming from `origin` (an Origin or Referer value) is trusted. */
export function isTrustedApp (apps: TrustedApp[], appId: unknown, origin: unknown): boolean {
  if (typeof appId !== 'string' || appId === '') return false;
  const requestOrigin = toOrigin(origin);
  for (const app of apps) {
    if (app.appId !== appId && app.appId !== '*') continue;
    if (originMatches(app.origin, requestOrigin)) return true;
  }
  return false;
}

/** The pattern, or a string describing why it is invalid. */
function parseOriginPattern (raw: string): OriginPattern | string {
  if (raw === '*') return { any: true };
  let text = raw;
  let trailingWildcard = false;
  if (text.endsWith('*')) {
    trailingWildcard = true;
    text = text.slice(0, -1);
    if (text.endsWith(':')) text = text.slice(0, -1); // `host:*`
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch (e) {
    return 'the origin is not a URL (expected <scheme>://<host>[:<port>])';
  }
  if (url.hostname === '') return 'the origin has no host';
  let host = url.hostname;
  let subdomainsOf = false;
  if (host.includes('*')) {
    if (!host.startsWith('*.') || host.slice(2).includes('*') || host.length <= 2) {
      return "'*' is only allowed as the whole first label of the host (e.g. https://*.example.com)";
    }
    subdomainsOf = true;
    host = host.slice(2);
  }
  const anyPort = trailingWildcard && ENDS_AT_AUTHORITY_RE.test(text) && !EXPLICIT_PORT_RE.test(text);
  return { any: false, protocol: url.protocol, host, subdomainsOf, port: anyPort ? null : url.port };
}

function toOrigin (value: unknown): URL | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return new URL(value);
  } catch (e) {
    return null;
  }
}

function originMatches (pattern: OriginPattern, origin: URL | null): boolean {
  if (pattern.any) return true;
  if (origin == null) return false;
  if (origin.protocol !== pattern.protocol) return false;
  if (pattern.port !== null && origin.port !== pattern.port) return false;
  if (pattern.subdomainsOf) {
    const suffix = '.' + pattern.host;
    return origin.hostname.length > suffix.length && origin.hostname.endsWith(suffix);
  }
  return origin.hostname === pattern.host;
}
