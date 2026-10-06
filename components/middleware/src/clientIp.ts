/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';
import proxyaddr from 'proxy-addr';

/**
 * The client address of a request, for the audit log (`source.ip`) and every
 * other place that records who called.
 *
 * `X-Forwarded-For` is only believed when it comes from a trusted proxy
 * (`http.trustedProxies`, default `['loopback']`): the chain is read from the
 * right, trusted hops are skipped, and the first untrusted address is the
 * client. A request whose TCP peer is not trusted gets the peer, whatever
 * header it sent. Without this, any client reaching the core directly could
 * choose the address written to the audit log.
 */

type TrustFn = (addr: string, index: number) => boolean;

type RequestLike = {
  headers: IncomingHttpHeaders;
  socket?: { remoteAddress?: string } | null;
  connection?: { remoteAddress?: string } | null;
};

const DEFAULT_TRUSTED_PROXIES: string[] = ['loopback'];

let trustedList: string[] = DEFAULT_TRUSTED_PROXIES;
let trustFn: TrustFn = proxyaddr.compile(DEFAULT_TRUSTED_PROXIES);

/**
 * Sets the trusted proxies for this process. Called once per process at app
 * setup with `http.trustedProxies`; `null`/`undefined` keeps the default.
 * Throws on an entry proxy-addr cannot compile (the config validator reports
 * those before boot).
 */
function configureTrustedProxies (list: string[] | null | undefined): void {
  const next = list == null ? DEFAULT_TRUSTED_PROXIES : list;
  trustFn = proxyaddr.compile(next);
  trustedList = next;
}

/** The current compiled trust function. */
function trustedProxyFn (): TrustFn {
  return trustFn;
}

/**
 * For express's `trust proxy` setting: always defers to the current list, so
 * a later `configureTrustedProxies` reaches `req.ip` / `req.protocol` too.
 */
function expressTrustProxy (addr: string, index: number): boolean {
  return trustFn(addr, index);
}

/** The configured list (a copy), e.g. to restore it after a test changed it. */
function currentTrustedProxies (): string[] {
  return [...trustedList];
}

/** The configured list, for the boot log. */
function trustedProxiesSummary (): string {
  return trustedList.length === 0 ? '[] (X-Forwarded-For never read)' : '[' + trustedList.join(', ') + ']';
}

type ConfigProblem = { message: string, path: Array<string | number> };

/**
 * Boot-time check of `http.trustedProxies` (used by the config validator):
 * problems refuse the boot, warnings are logged.
 */
function checkTrustedProxiesConfig (list: unknown, hfsWorkers: unknown): { problems: ConfigProblem[], warnings: string[] } {
  const problems: ConfigProblem[] = [];
  const warnings: string[] = [];
  const path = ['http', 'trustedProxies'];
  if (list == null) return { problems, warnings };
  if (!Array.isArray(list)) {
    problems.push({ message: 'http.trustedProxies must be a list of IPs, CIDRs or the names loopback / linklocal / uniquelocal', path });
    return { problems, warnings };
  }
  list.forEach((entry: unknown, i: number) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      problems.push({ message: `http.trustedProxies[${i}] must be a non-empty string`, path: [...path, i] });
      return;
    }
    try {
      proxyaddr.compile([entry]);
    } catch (e) {
      problems.push({ message: `http.trustedProxies[${i}] '${entry}': ${(e as Error).message}`, path: [...path, i] });
    }
  });
  // A list that trusts a documentation-only address (TEST-NET-2, the IPv6 discard prefix) trusts
  // every client, so any client could choose the address recorded for it: 0.0.0.0/0, ::/0, or an
  // IPv4-mapped IPv6 subnet with a short prefix (::ffff:10.0.0.0/8 instead of ::ffff:10.0.0.0/104).
  if (problems.length === 0) {
    const trust = proxyaddr.compile(list as string[]);
    if (trust('198.51.100.7', 0) || trust('100::7', 0)) {
      problems.push({
        message: 'http.trustedProxies trusts every address (an entry such as 0.0.0.0/0, ::/0, or an ' +
          'IPv4-mapped IPv6 subnet with a short prefix like ::ffff:10.0.0.0/8). Write IPv4 subnets in ' +
          'IPv4 notation, e.g. 10.0.0.0/8',
        path
      });
    }
  }
  if (problems.length === 0 && Number(hfsWorkers) > 0 && !proxyaddr.compile(list as string[])('127.0.0.1', 0)) {
    warnings.push('http.trustedProxies does not include loopback while HFS workers run: high-frequency ' +
      'series requests forwarded by the core itself will be recorded as coming from 127.0.0.1. ' +
      "Add 'loopback' to the list.");
  }
  return { problems, warnings };
}

/** `::ffff:203.0.113.7` -> `203.0.113.7`, so one client is recorded as one string. */
function normaliseIp (ip: string): string {
  return ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

function peerAddress (req: RequestLike): string | null {
  return req.socket?.remoteAddress ?? req.connection?.remoteAddress ?? null;
}

/**
 * The client address of `req` under the configured trusted proxies, or `null`
 * when the request carries no peer address (a closed socket).
 */
function clientIp (req: RequestLike): string | null {
  const peer = peerAddress(req);
  if (peer == null) return null;
  const resolved = proxyaddr(req, trustFn);
  // A trusted proxy that sends something which is not an address (operator
  // misconfiguration) must not put arbitrary text in the audit log.
  return normaliseIp(isIP(resolved) ? resolved : peer);
}

export { configureTrustedProxies, trustedProxyFn, expressTrustProxy, currentTrustedProxies, trustedProxiesSummary, checkTrustedProxiesConfig, clientIp, normaliseIp, DEFAULT_TRUSTED_PROXIES };
