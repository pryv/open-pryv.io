/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { getConfigSync } from '@pryv/boiler';
import type { IncomingMessage } from 'node:http';
import {
  WebhookCallError,
  isRefusedAddress,
  compileAllowList,
  allowEntryProblem,
  checkedLookup,
  stripBrackets
} from '../webhooks/destination.ts';
import type { AllowList, Problem } from '../webhooks/destination.ts';

/**
 * A `fetch` for calls to a counterparty: consent (CMC) deliveries, delegation
 * notices, OAuth revocation notices. Their URL comes from the other side, so
 * the call is refused, before any socket connects, when it points to a
 * loopback, private, link-local or otherwise reserved address (the address
 * rules of webhooks), uses `http:` (unless `cluster.allowInsecurePeerUrl`) or
 * carries credentials. A host name is resolved with a checked lookup pinned to
 * the connection, so a DNS answer cannot switch to an internal address after
 * the check. Redirects are not followed and the answer is capped at 1 MiB.
 *
 * The platform's own host names (`core.url`'s host, `dns.domain` and its
 * subdomains, the `service.api` host) are trusted by name. An IP literal is
 * never trusted that way, a private `core.url` literal included: it, and other
 * peers on a private network, are listed in `cmc.allowedPrivateHosts` (host
 * names, IPs or CIDR ranges).
 */

const MAX_URL_LENGTH = 2048;
const MAX_PEER_RESPONSE_BYTES = 1024 * 1024;

type PeerRefusalKind = 'url' | 'scheme' | 'address' | 'redirect' | 'too-large';
type PeerSettings = { allow: AllowList; allowInsecure: boolean; isPlatformHost: (host: string) => boolean };
type PeerFetchInit = { method?: string; headers?: HeadersInit; body?: string | Buffer | null; signal?: AbortSignal | null; redirect?: string };
type PeerTransport = (url: string, init?: PeerFetchInit) => Promise<Response>;

class PeerFetchRefusedError extends Error {
  code = 'EPEERREFUSED' as const;
  kind: PeerRefusalKind;
  host: string;
  constructor (kind: PeerRefusalKind, host: string) {
    super(`peer call refused: ${kind}, host '${host}'`);
    this.name = 'PeerFetchRefusedError';
    this.kind = kind;
    this.host = host;
  }
}

function lowerHost (host: string): string {
  const h = host.toLowerCase();
  return h.endsWith('.') ? h.slice(0, -1) : h;
}

/** True for the platform's own host names: `core.url`'s host, `dns.domain` and below, the `service.api` host. */
function platformHostMatcher (opts: { coreUrl?: unknown; dnsDomain?: unknown; serviceApi?: unknown }): (host: string) => boolean {
  const exact = new Set<string>();
  const patterns: RegExp[] = [];
  const suffixes: string[] = [];
  if (typeof opts.coreUrl === 'string' && opts.coreUrl !== '') {
    try { exact.add(lowerHost(new URL(opts.coreUrl).hostname)); } catch { /* not a URL: ignored */ }
  }
  if (typeof opts.dnsDomain === 'string' && opts.dnsDomain.trim() !== '') {
    const domain = lowerHost(opts.dnsDomain.trim());
    exact.add(domain);
    suffixes.push('.' + domain);
  }
  if (typeof opts.serviceApi === 'string' && opts.serviceApi !== '') {
    const marker = '{username}';
    const placeholder = 'xusernamex0';
    try {
      const host = lowerHost(new URL(opts.serviceApi.split(marker).join(placeholder)).hostname);
      if (host.includes(placeholder)) {
        const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        patterns.push(new RegExp('^' + host.split(placeholder).map(escape).join('[a-z0-9][a-z0-9-]*') + '$'));
      } else {
        exact.add(host);
      }
    } catch { /* not a URL: ignored */ }
  }
  return function isPlatformHost (host: string): boolean {
    const h = lowerHost(host);
    if (h === '') return false;
    return exact.has(h) || suffixes.some((s) => h.endsWith(s)) || patterns.some((p) => p.test(h));
  };
}

/** Boot-time check of the `cmc` config block (the outbound allow-list). */
function describeCmcConfig (raw: unknown): { problems: Problem[] } {
  const problems: Problem[] = [];
  const block = (raw != null && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
  const hosts = block.allowedPrivateHosts;
  if (hosts != null) {
    if (!Array.isArray(hosts)) {
      problems.push({ message: 'cmc.allowedPrivateHosts must be a list of host names, IPs or CIDR ranges', path: ['cmc', 'allowedPrivateHosts'] });
    } else {
      hosts.forEach((entry: unknown, i: number) => {
        const problem = allowEntryProblem(entry);
        if (problem != null) problems.push({ message: `cmc.allowedPrivateHosts[${i}] '${String(entry)}' ${problem}`, path: ['cmc', 'allowedPrivateHosts', i] });
      });
    }
  }
  return { problems };
}

let compiled: { key: string; allow: AllowList } | null = null;
let matcher: { key: string; isPlatformHost: (host: string) => boolean } | null = null;

/** Settings read from the config on each call, so a change applies to the next call. */
function currentPeerSettings (): PeerSettings {
  let entries: unknown[] = [];
  let allowInsecure = false;
  let platform: { coreUrl?: unknown; dnsDomain?: unknown; serviceApi?: unknown } = {};
  try {
    const config = getConfigSync();
    const list = config.get('cmc:allowedPrivateHosts');
    if (Array.isArray(list)) entries = list;
    allowInsecure = config.get('cluster:allowInsecurePeerUrl') === true;
    platform = { coreUrl: config.get('core:url'), dnsDomain: config.get('dns:domain'), serviceApi: config.get('service:api') };
  } catch {
    // config not loaded: strict defaults
  }
  const key = JSON.stringify(entries);
  if (compiled == null || compiled.key !== key) compiled = { key, allow: compileAllowList(entries) };
  const platformKey = JSON.stringify([platform.coreUrl, platform.dnsDomain, platform.serviceApi]);
  if (matcher == null || matcher.key !== platformKey) matcher = { key: platformKey, isPlatformHost: platformHostMatcher(platform) };
  return { allow: compiled.allow, allowInsecure, isPlatformHost: matcher.isPlatformHost };
}

/** The checks made before any connection; null when the URL may be called. */
function peerUrlRefusal (rawUrl: string, settings: PeerSettings = currentPeerSettings()): PeerFetchRefusedError | null {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) return new PeerFetchRefusedError('url', '');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return new PeerFetchRefusedError('url', '');
  }
  const host = stripBrackets(url.hostname);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return new PeerFetchRefusedError('scheme', host);
  if (url.protocol === 'http:' && !settings.allowInsecure) return new PeerFetchRefusedError('scheme', host);
  if (url.username !== '' || url.password !== '') return new PeerFetchRefusedError('url', host);
  if (host === '') return new PeerFetchRefusedError('url', '');
  if (isIP(host) !== 0 && isRefusedAddress(host, settings.allow)) return new PeerFetchRefusedError('address', host);
  return null;
}

function headersRecord (headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers ?? {}).forEach((value, name) => { out[name] = value; });
  return out;
}

/** The guarded client: node http(s) with the checked lookup, no redirects, a capped body. */
function guardedTransport (rawUrl: string, init: PeerFetchInit = {}, settings: PeerSettings = currentPeerSettings()): Promise<Response> {
  const url = new URL(rawUrl);
  const host = stripBrackets(url.hostname);
  const name = lowerHost(host);
  const allowedByName = isIP(host) === 0 && (settings.allow.names.has(name) || settings.isPlatformHost(name));
  const body = init.body == null ? null : (typeof init.body === 'string' ? Buffer.from(init.body) : init.body);
  const headers = headersRecord(init.headers);
  if (body != null) headers['content-length'] = String(body.length);
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown) => { if (!settled) { settled = true; reject(err); } };
    const req = request({
      hostname: host,
      port: url.port === '' ? undefined : Number(url.port),
      path: url.pathname + url.search,
      method: init.method ?? 'GET',
      headers,
      agent: false,
      signal: init.signal ?? undefined,
      lookup: (allowedByName || isIP(host) !== 0) ? undefined : checkedLookup(settings.allow, host)
    }, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.destroy();
        return fail(new PeerFetchRefusedError('redirect', host));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_PEER_RESPONSE_BYTES) {
          res.destroy();
          return fail(new PeerFetchRefusedError('too-large', host));
        }
        chunks.push(chunk);
      });
      res.on('error', fail);
      res.on('end', () => {
        if (settled) return;
        if (status < 200 || status > 599) return fail(new Error(`unexpected HTTP status ${status} from '${host}'`));
        // No statusText: node's parser accepts reason-phrase bytes that
        // `Response` rejects. Any answer `Headers`/`Response` refuse is a
        // connection error, never an exception escaping this listener.
        let response: Response;
        try {
          const responseHeaders = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v == null) continue;
            if (Array.isArray(v)) v.forEach((one) => responseHeaders.append(k, one));
            else responseHeaders.set(k, String(v));
          }
          response = new Response(status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks), { status, headers: responseHeaders });
        } catch (err) {
          return fail(err);
        }
        settled = true;
        resolve(response);
      });
    });
    req.on('error', (err: unknown) => {
      if (err instanceof WebhookCallError && err.kind === 'refused') return fail(new PeerFetchRefusedError('address', host));
      fail(err);
    });
    req.end(body ?? undefined);
  });
}

let transport: PeerTransport | null = null;

/**
 * Call a counterparty's URL. Rejects with a PeerFetchRefusedError (code
 * `EPEERREFUSED`) when the destination may not be called; otherwise behaves
 * like `fetch` (socket errors and aborts propagate as such).
 */
async function peerFetch (rawUrl: string, init: PeerFetchInit = {}, settings: PeerSettings = currentPeerSettings()): Promise<Response> {
  const refusal = peerUrlRefusal(rawUrl, settings);
  if (refusal != null) throw refusal;
  if (transport != null) return await transport(rawUrl, init);
  return await guardedTransport(rawUrl, init, settings);
}

/**
 * Tests: route the calls that passed the URL checks to `fn` (the api-server
 * suites point it at `globalThis.fetch`, which they replace with an
 * in-process shim). `null` restores the guarded client.
 */
function setPeerTransportForTests (fn: PeerTransport | null): void {
  transport = fn;
}

export {
  MAX_PEER_RESPONSE_BYTES,
  PeerFetchRefusedError,
  peerFetch,
  peerUrlRefusal,
  platformHostMatcher,
  describeCmcConfig,
  currentPeerSettings,
  setPeerTransportForTests
};
export type { PeerRefusalKind, PeerSettings, PeerFetchInit };
