/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Where telemetry is allowed to travel in cleartext.
 *
 * The rule being protected is "a credentialed OTLP payload must not cross a
 * network unencrypted", not "the collector must be reachable on loopback".
 * The recommended zero-egress deployment runs the collector as a sidecar, so
 * the core reaches it across the container bridge (a 172.16/12 gateway, say)
 * rather than over 127.0.0.1. That hop leaves neither the host nor the
 * operator's trust boundary, and demanding a certificate for it pushes
 * operators off the supported path instead of protecting anything.
 *
 * So cleartext is permitted to host-local and private destinations, and
 * refused to anything routable on the public internet. `https:` is always
 * fine, wherever it points.
 *
 * This module is the single definition, shared by the configuration path
 * (`bin/observability.js`) and the emitter (`startup.ts`). Keeping it in one
 * place is the point: when the check lived only in the CLI, writing the value
 * straight into PlatformDB, or exporting the environment variable, bypassed
 * it entirely, so the constraint described the tool rather than the traffic.
 */

/** IPv4 dotted-quad, or null when the string is not one. */
function ipv4Octets (hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return octets;
}

/**
 * True when the address cannot be routed to from off the machine or off the
 * operator's own network: loopback, RFC1918 private space, link-local, and
 * their IPv6 equivalents.
 */
function isHostLocal (hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  const octets = ipv4Octets(host);
  if (octets != null) {
    const [a, b] = octets;
    if (a === 127) return true;                          // 127.0.0.0/8 loopback
    if (a === 10) return true;                           // 10.0.0.0/8 private
    if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true;             // 192.168.0.0/16 private
    if (a === 169 && b === 254) return true;             // 169.254.0.0/16 link-local
    return false;
  }

  if (host === '::1' || host === '::') return true;      // IPv6 loopback / unspecified
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;      // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;      // fc00::/7 unique-local
  // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
  const mapped = /^::ffff:(.+)$/.exec(host);
  if (mapped != null) return isHostLocal(mapped[1]);

  return false;
}

/**
 * @returns a reason to refuse the endpoint, or null when it is acceptable.
 *          The caller decides what refusal means: the CLI throws, the
 *          emitter declines to activate.
 */
function endpointRefusal (endpoint: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return '"' + endpoint + '" is not a valid URL';
  }
  if (parsed.protocol === 'https:') return null;
  if (parsed.protocol !== 'http:') {
    return 'unsupported protocol ' + parsed.protocol + '// (expected https: or http: to a host-local collector)';
  }
  if (isHostLocal(parsed.hostname)) return null;
  return 'refusing cleartext telemetry to "' + parsed.hostname +
    '", which is not host-local: use https:, or point at a collector on ' +
    'loopback, private (RFC1918) or link-local space';
}

export { isHostLocal, endpointRefusal };
