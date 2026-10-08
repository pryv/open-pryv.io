/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { getConfigSync } from '@pryv/boiler';
import type { IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import type { LookupAddress } from 'node:dns';

/**
 * Outbound calls of webhooks: the URL rules, the destination address rules and
 * the HTTP POST itself.
 *
 * The destination is checked on every call, against the addresses the host
 * name resolves to at that moment (a custom `lookup` runs before the socket
 * connects), so a DNS answer that changed since the webhook was created is
 * checked too. Redirects are not followed, the call is aborted after
 * `webhooks.requestTimeoutMs` and only the response status is read.
 *
 * `webhooks.allowedPrivateHosts` lists the host names, IPs or CIDR ranges of
 * receivers on a private network that may be called anyway.
 */

const MAX_URL_LENGTH = 2048;
const DEFAULT_TIMEOUT_MS = 10000;
const PROTOCOLS = ['https:', 'http:'];

// Addresses a webhook does not call unless allowed by the operator.
const REFUSED_IPV4: Array<[string, number]> = [
  ['0.0.0.0', 8], // unspecified, "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata services
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4] // reserved, incl. broadcast
];
const REFUSED_IPV6: Array<[string, number]> = [
  ['::', 96], // unspecified, loopback, IPv4-compatible (deprecated)
  ['100::', 64], // discard-only
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8] // multicast
];

const REFUSED = new BlockList();
for (const [net, bits] of REFUSED_IPV4) REFUSED.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of REFUSED_IPV6) REFUSED.addSubnet(net, bits, 'ipv6');

const HOSTNAME_RE = /^[a-z0-9_]([a-z0-9_.-]*[a-z0-9_])?$/;

type AllowList = { names: Set<string>; ranges: BlockList };
type DestinationSettings = { allow: AllowList; timeoutMs: number };
type Problem = { message: string; path: Array<string | number> };
type FailureKind = 'invalid-url' | 'refused' | 'connection' | 'timeout' | 'status';

/**
 * A failed webhook call. `response.status` is set when the receiver answered
 * (non-2xx, 3xx included since redirects are not followed). The message never
 * carries the URL path or query.
 */
class WebhookCallError extends Error {
  kind: FailureKind;
  host: string;
  response?: { status: number };
  constructor (kind: FailureKind, host: string, status?: number) {
    super(`webhook call failed: ${kind}`);
    this.name = 'WebhookCallError';
    this.kind = kind;
    this.host = host;
    if (status != null) this.response = { status };
  }
}

function stripBrackets (host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** Host name as compared with the allow-list: lowercase, punycode, no trailing dot. */
function normaliseHostName (host: string): string | null {
  try {
    const name = new URL(`http://${host}/`).hostname;
    return name.endsWith('.') ? name.slice(0, -1) : name;
  } catch {
    return null;
  }
}

// The 8 groups of an IPv6 address, or null. The URL parser gives the
// canonical form (hex groups only, at most one '::').
function ipv6Groups (address: string): number[] | null {
  let canonical: string;
  try {
    canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const parts = canonical.split('::');
  const head = parts[0] === '' ? [] : parts[0].split(':');
  const tail = parts.length < 2 || parts[1] === '' ? [] : parts[1].split(':');
  const fill = parts.length < 2 ? 0 : 8 - head.length - tail.length;
  const groups = [...head, ...new Array(fill).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

// IPv4 address carried by an IPv4-mapped, NAT64 (64:ff9b::/96) or 6to4
// (2002::/16) IPv6 address.
function embeddedIPv4 (g: number[]): string | null {
  const v4 = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && g[5] === 0xffff) return v4(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6], g[7]);
  if (g[0] === 0x2002) return v4(g[1], g[2]);
  return null;
}

/** True when a webhook may not call `address` (an IP literal; anything else is refused). */
function isRefusedAddress (address: string, allow: AllowList = emptyAllowList()): boolean {
  const family = isIP(address);
  if (family === 4) {
    return !allow.ranges.check(address, 'ipv4') && REFUSED.check(address, 'ipv4');
  }
  if (family !== 6) return true;
  const groups = ipv6Groups(address);
  if (groups == null) return true;
  if (allow.ranges.check(address, 'ipv6')) return false;
  const v4 = embeddedIPv4(groups);
  if (v4 != null && isRefusedAddress(v4, allow)) return true;
  return REFUSED.check(address, 'ipv6');
}

function emptyAllowList (): AllowList {
  return { names: new Set(), ranges: new BlockList() };
}

/** Why an allow-list entry is not usable, or null. */
function allowEntryProblem (entry: unknown): string | null {
  if (typeof entry !== 'string' || entry.trim() === '') return 'must be a non-empty string';
  const value = entry.trim();
  if (value.includes('/')) {
    const [base, bits, ...rest] = value.split('/');
    const family = isIP(stripBrackets(base));
    if (family === 0 || rest.length > 0 || !/^\d{1,3}$/.test(bits)) return 'is not a valid CIDR range';
    const prefix = Number(bits);
    if (prefix > (family === 4 ? 32 : 128)) return 'has an invalid prefix length';
    if (prefix === 0) return 'would allow every address; list the hosts or ranges of the receivers';
    return null;
  }
  if (isIP(stripBrackets(value)) !== 0) return null;
  const name = normaliseHostName(value);
  if (name == null || name.length > 253 || !HOSTNAME_RE.test(name)) return 'is neither an IP address, a CIDR range nor a host name';
  return null;
}

/** Compile `webhooks.allowedPrivateHosts`; unusable entries are skipped (the boot check reports them). */
function compileAllowList (entries: unknown): AllowList {
  const allow = emptyAllowList();
  if (!Array.isArray(entries)) return allow;
  for (const entry of entries) {
    if (allowEntryProblem(entry) != null) continue;
    const value = (entry as string).trim();
    if (value.includes('/')) {
      const [base, bits] = value.split('/');
      const address = stripBrackets(base);
      allow.ranges.addSubnet(address, Number(bits), isIP(address) === 4 ? 'ipv4' : 'ipv6');
    } else if (isIP(stripBrackets(value)) !== 0) {
      const address = stripBrackets(value);
      allow.ranges.addAddress(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
    } else {
      allow.names.add(normaliseHostName(value) as string);
    }
  }
  return allow;
}

/** Boot-time check of the `webhooks` config block. */
function describeWebhooksConfig (raw: unknown): { problems: Problem[] } {
  const problems: Problem[] = [];
  const block = (raw != null && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
  const hosts = block.allowedPrivateHosts;
  if (hosts != null) {
    if (!Array.isArray(hosts)) {
      problems.push({ message: 'webhooks.allowedPrivateHosts must be a list of host names, IPs or CIDR ranges', path: ['webhooks', 'allowedPrivateHosts'] });
    } else {
      hosts.forEach((entry: unknown, i: number) => {
        const problem = allowEntryProblem(entry);
        if (problem != null) problems.push({ message: `webhooks.allowedPrivateHosts[${i}] '${String(entry)}' ${problem}`, path: ['webhooks', 'allowedPrivateHosts', i] });
      });
    }
  }
  const timeout = block.requestTimeoutMs;
  if (timeout != null && !(Number.isInteger(timeout) && (timeout as number) > 0)) {
    problems.push({ message: 'webhooks.requestTimeoutMs must be a positive integer (milliseconds)', path: ['webhooks', 'requestTimeoutMs'] });
  }
  return { problems };
}

let compiled: { key: string; allow: AllowList } | null = null;

/** Settings read from the config on each call, so a change applies to the next call. */
function currentSettings (): DestinationSettings {
  let block: Record<string, unknown> = {};
  try {
    const value = getConfigSync().get('webhooks');
    if (value != null && typeof value === 'object' && !Array.isArray(value)) block = value as Record<string, unknown>;
  } catch {
    // config not loaded: strict defaults
  }
  const entries = Array.isArray(block.allowedPrivateHosts) ? block.allowedPrivateHosts : [];
  const key = JSON.stringify(entries);
  if (compiled == null || compiled.key !== key) compiled = { key, allow: compileAllowList(entries) };
  const timeout = block.requestTimeoutMs;
  const timeoutMs = Number.isInteger(timeout) && (timeout as number) > 0 ? timeout as number : DEFAULT_TIMEOUT_MS;
  return { allow: compiled.allow, timeoutMs };
}

type Parsed = { ok: true; url: URL; host: string } | { ok: false; kind: FailureKind; host: string; message: string };

function parseDestination (raw: unknown, allow: AllowList): Parsed {
  const invalid = (message: string, host = ''): Parsed => ({ ok: false, kind: 'invalid-url', host, message });
  if (typeof raw !== 'string' || raw.length === 0) return invalid('The webhook url must be a non-empty string.');
  if (raw.length > MAX_URL_LENGTH) return invalid(`The webhook url must be at most ${MAX_URL_LENGTH} characters.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return invalid('The webhook url must be an absolute URL.');
  }
  const host = stripBrackets(url.hostname);
  if (!PROTOCOLS.includes(url.protocol)) return invalid('The webhook url must use the https or http scheme.', host);
  if (url.username !== '' || url.password !== '') return invalid('The webhook url must not contain credentials.', host);
  if (host === '') return invalid('The webhook url must have a host.');
  if (isIP(host) !== 0 && isRefusedAddress(host, allow)) {
    return { ok: false, kind: 'refused', host, message: 'The webhook url must not point to a loopback, private, link-local or otherwise reserved address.' };
  }
  return { ok: true, url, host: host.endsWith('.') ? host.slice(0, -1) : host };
}

/**
 * What is wrong with `url` as a webhook destination, as far as can be decided
 * without resolving its host name (scheme, credentials, length, IP literal),
 * or null.
 */
function webhookUrlProblem (url: unknown, allow: AllowList = currentSettings().allow): string | null {
  const parsed = parseDestination(url, allow);
  return parsed.ok ? null : parsed.message;
}

// Resolves like dns.lookup, then refuses the host when any of its addresses is
// refused, before the socket connects.
function checkedLookup (allow: AllowList, host: string): LookupFunction {
  return function (hostname, options, callback) {
    dnsLookup(hostname, { family: options.family, hints: options.hints, all: true }, (err, addresses) => {
      if (err != null) return callback(err, '');
      const list = addresses as LookupAddress[];
      if (list.length === 0 || list.some((a) => isRefusedAddress(a.address, allow))) {
        return callback(new WebhookCallError('refused', host) as NodeJS.ErrnoException, '');
      }
      if (options.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}

/**
 * POST `payload` as JSON to `rawUrl`. Resolves with the status of a 2xx answer;
 * rejects with a WebhookCallError otherwise.
 */
async function postWebhook (rawUrl: unknown, payload: unknown, settings: DestinationSettings = currentSettings()): Promise<{ status: number }> {
  const parsed = parseDestination(rawUrl, settings.allow);
  if (!parsed.ok) throw new WebhookCallError(parsed.kind, parsed.host);
  const { url, host } = parsed;
  const allowedByName = settings.allow.names.has(host.toLowerCase());
  const body = Buffer.from(JSON.stringify(payload));
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return await new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
    let settled = false;
    function done (err: WebhookCallError | null, status: number = 0) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err != null) reject(err);
      else resolve({ status });
    }
    const req = request({
      hostname: host,
      port: url.port === '' ? undefined : Number(url.port),
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      agent: false,
      signal: controller.signal,
      lookup: allowedByName ? undefined : checkedLookup(settings.allow, host)
    }, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      res.destroy(); // the body is not read
      if (status >= 200 && status < 300) done(null, status);
      else done(new WebhookCallError('status', host, status));
    });
    req.on('error', (err: Error) => {
      if (err instanceof WebhookCallError) return done(err);
      done(new WebhookCallError(controller.signal.aborted ? 'timeout' : 'connection', host));
    });
    req.end(body);
  });
}

/** One-line reason for the server log: failure kind, host and status, never the path or query. */
function describeCallFailure (err: unknown): string {
  if (!(err instanceof WebhookCallError)) return 'unexpected error';
  const status = err.response != null ? ` (status ${err.response.status})` : '';
  return `${err.kind}, host '${err.host}'${status}`;
}

export {
  MAX_URL_LENGTH,
  DEFAULT_TIMEOUT_MS,
  WebhookCallError,
  isRefusedAddress,
  compileAllowList,
  allowEntryProblem,
  describeWebhooksConfig,
  currentSettings,
  webhookUrlProblem,
  postWebhook,
  describeCallFailure
};
export type { AllowList, DestinationSettings };
