/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '@pryv/boiler';
import type { AdapterRoute } from 'business/src/adapterRoutes.ts';
import { redactUrl } from 'utils/src/redactUrl.ts';
import { usernameInHost } from 'business/src/usernameSubdomains.ts';
import { failIngress, hasEncodedSeparatorOrDotSegment } from './ingressGuard.ts';
import { buildWorkerProxy } from './workerIngress.ts';
import { addressedLabelOf } from './addressedAccount.ts';
import type { PlatformRoutedLabel } from './addressedAccount.ts';
import { platformRoutedLabels } from './platformLabels.ts';
import { resolveUserCore } from './routes/reg/userCore.ts';
import type { UserCorePlatform } from './routes/reg/userCore.ts';

/**
 * In-process dispatcher for adapter routes: a sidecar on the same host
 * reached under `/adapter/<name>/` (and the route's other prefixes) on every
 * host this core serves, in both topologies.
 *
 * First in the request chain (only Socket.IO's own path is ahead of it): the
 * API middleware (CORS, JSON parser, username rewriting, auth, audit) never
 * sees these requests. The core forwards every method, the body and every
 * header except the hop-by-hop ones, sets X-Forwarded-For / -Proto / -Host,
 * and passes the answer back unchanged. It authenticates nothing on these
 * paths: the upstream must.
 *
 * Per-user addresses (with `addressing`, on a platform with per-user hosts):
 * a request on `https://<account>.<domain>/adapter/<name>/...` is addressed
 * to that account. The core asks the platform where the account lives: on
 * another core the answer is 421 `wrong-core` with that core's URL (never a
 * redirect: it would drop the Authorization header), here the request is
 * forwarded with X-Adapter-Name and X-Adapter-Base. A service, core or
 * hosted-site host is a platform address: forwarded without them.
 */

type Fallback = (req: IncomingMessage, res: ServerResponse) => void;
type Proxy = ReturnType<typeof buildWorkerProxy>;
type Entry = { route: AdapterRoute; prefix: string; proxy: Proxy; tooLarge: string };
type AdapterDispatch = ((req: IncomingMessage, res: ServerResponse, fallback: Fallback) => void) & {
  /** For a `100-continue` request: answers it (true) when it is refused before the body is sent. */
  refuseBeforeContinue: (req: IncomingMessage, res: ServerResponse) => boolean
};
type ContinueServer = {
  on: (event: 'checkContinue', listener: (req: IncomingMessage, res: ServerResponse) => void) => unknown;
  emit: (event: 'request', req: IncomingMessage, res: ServerResponse) => boolean;
};

/**
 * How the ingress reads per-user addresses: the platform-routed-labels
 * predicate (the username rewriter's), and for tests the platform slice the
 * placement lookup uses (the platform singleton otherwise).
 */
type AdapterAddressing = { isPlatformRoutedLabel: PlatformRoutedLabel; platform?: UserCorePlatform };

const JSON_ERROR_HEADERS = { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };

/**
 * A refusal before the body was read: the connection is closed after it, so
 * an unread (possibly unbounded) body is not drained over keep-alive.
 */
function refuse (req: IncomingMessage, res: ServerResponse, status: number, id: string, message: string, extra: Record<string, string> = {}) {
  req.resume();
  res.writeHead(status, { ...JSON_ERROR_HEADERS, connection: 'close' });
  res.end(JSON.stringify({ error: { id, message, ...extra } }));
}

/**
 * The per-user address reading of a configuration: on a platform with
 * per-user hosts, the predicate the username rewriter uses; in dnsLess mode
 * none (the host is the core's own name, never an account).
 */
function adapterAddressingFor (config: { get: (key: string) => unknown }): AdapterAddressing | null {
  return usernameInHost(config) ? { isPlatformRoutedLabel: platformRoutedLabels(config) } : null;
}

/** The query of a request target as received (from `?`, without a fragment). */
function rawSearchOf (url: string): string {
  const hashAt = url.indexOf('#');
  const target = hashAt < 0 ? url : url.slice(0, hashAt);
  const queryAt = target.indexOf('?');
  return queryAt < 0 ? '' : target.slice(queryAt);
}

function buildAdapterIngress (opts: { routes: Map<string, AdapterRoute>; logger: Logger; ca?: string; addressing?: AdapterAddressing | null }) {
  const { routes, logger } = opts;
  const addressing = opts.addressing ?? null;
  const entries: Entry[] = [];
  for (const route of routes.values()) {
    const tooLarge = `request body exceeds adapterRoutes.${route.name}.maxBodyBytes (${route.maxBodyBytes} bytes)`;
    // A connection per request: the sidecar is on this host (setup is cheap),
    // no pooled socket can be closed by the sidecar while a request is sent on
    // it (a spurious 502, a non-idempotent request included), and no framing
    // mistake can carry over to another client's request.
    const agent = route.protocol === 'https:' ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
    const proxy = buildWorkerProxy({
      name: 'adapter',
      label: `adapter ${route.name}`,
      host: route.hostname,
      port: route.port,
      protocol: route.protocol,
      ca: opts.ca,
      agent,
      logger,
      upstreamIdleTimeoutMs: route.idleTimeoutMs,
      stripHopByHop: true,
      forwardedHeaders: 'adapter',
      maxBodyBytes: route.maxBodyBytes,
      messages: {
        timedOut: `adapter ${route.name} timed out`,
        unreachable: `adapter ${route.name} unreachable`,
        tooLarge
      },
      logPathOnly: true,
      releaseOnClientClose: true
    });
    for (const prefix of route.paths) entries.push({ route, prefix, proxy, tooLarge });
  }

  function match (pathname: string): Entry | null {
    for (const entry of entries) {
      if (pathname === entry.prefix.slice(0, -1) || pathname.startsWith(entry.prefix)) return entry;
    }
    return null;
  }

  /** The route entry and the parsed URL of a request, or null when no route claims it. */
  function routeOf (req: IncomingMessage): { entry: Entry; url: URL } | null {
    // Origin-form only: prefixing keeps `//x/y` a path instead of a host.
    if (entries.length === 0 || req.url == null || !req.url.startsWith('/')) return null;
    let url: URL;
    try { url = new URL('http://placeholder' + req.url); } catch { return null; }
    // Matched on the normalised path (dot segments resolved, `\` read as `/`),
    // which is also the path forwarded: a raw path that normalises outside the
    // prefix never reaches the upstream.
    const entry = match(url.pathname);
    return entry == null ? null : { entry, url };
  }

  function declaredTooLarge (req: IncomingMessage, entry: Entry): boolean {
    const declared = Number(req.headers['content-length']);
    return Number.isFinite(declared) && declared > entry.route.maxBodyBytes;
  }

  const dispatch = function dispatch (req: IncomingMessage, res: ServerResponse, fallback: Fallback): void {
    const routed = routeOf(req);
    if (routed == null) {
      fallback(req, res);
      return;
    }
    const { entry, url } = routed;
    const started = Date.now();
    const shownPath = redactUrl(url.pathname);
    if (hasEncodedSeparatorOrDotSegment(url.pathname) || /%00/.test(url.pathname)) {
      logger.warn(`[adapter-ingress] ${entry.route.name}: encoded separator or dot segment refused ${req.method} ${shownPath}`);
      refuse(req, res, 400, 'invalid-request-structure', `adapter ${entry.route.name}: encoded separators and dot segments are not accepted in the path`);
      return;
    }
    // TRACE would echo the request, credentials included (cross-site tracing):
    // refused here, as nginx does.
    if (req.method === 'TRACE') {
      logger.warn(`[adapter-ingress] ${entry.route.name}: TRACE refused ${shownPath}`);
      refuse(req, res, 405, 'invalid-operation', `adapter ${entry.route.name}: TRACE is not allowed`);
      return;
    }
    // Only plain chunked framing is re-framed: another coding (e.g. gzip, chunked)
    // would reach the upstream undecoded and unlabelled.
    const te = req.headers['transfer-encoding'];
    if (te != null && te.trim().toLowerCase() !== 'chunked') {
      logger.warn(`[adapter-ingress] ${entry.route.name}: transfer-encoding other than chunked refused ${req.method} ${shownPath}`);
      refuse(req, res, 400, 'invalid-request-structure', `adapter ${entry.route.name}: only the chunked transfer-encoding is accepted`);
      return;
    }
    res.once('close', () => {
      logger.debug(`[adapter-ingress] ${entry.route.name} ${req.method} ${shownPath} ${res.statusCode}${res.writableFinished ? '' : ' (not finished)'} ${Date.now() - started} ms`);
    });
    const targetPath = url.pathname + rawSearchOf(req.url as string);
    const addressed = addressing == null ? null : addressedLabelOf(req.headers.host, addressing.isPlatformRoutedLabel);
    // No account is named `adapter` while routes are served (the boot check
    // and registration refuse it): that host is a platform address too.
    const label = addressed === 'adapter' ? null : addressed;
    // A platform address, or a declared body over the cap (refused by the
    // proxy without the upstream, before any lookup).
    if (label == null || declaredTooLarge(req, entry)) {
      entry.proxy(req, res, targetPath);
      return;
    }
    forwardAddressed(req, res, entry, label, targetPath, shownPath).catch((err: unknown) => {
      failIngress(req, res, err, logger, '[adapter-ingress]');
    });
  } as AdapterDispatch;

  /**
   * A request addressed to an account: forwarded with the account's name and
   * base when the platform serves it here (or does not map it: the sidecar's
   * own authentication answers a stranger, as for any request), 421 with the
   * account's core when it lives on another one. Never forwarded on a guess.
   */
  async function forwardAddressed (req: IncomingMessage, res: ServerResponse, entry: Entry, label: string, targetPath: string, shownPath: string): Promise<void> {
    const placement = await resolveUserCore(label, addressing?.platform != null ? { platform: addressing.platform } : {});
    // The client left during the lookup: nothing to answer.
    if (res.destroyed || res.headersSent) return;
    const name = entry.route.name;
    if (placement.kind === 'local') {
      entry.proxy(req, res, targetPath, { name: label, rootPath: entry.route.paths[0] });
      return;
    }
    if (placement.kind === 'remote' || placement.reason === 'core-unresolvable') {
      logger.warn(`[adapter-ingress] ${name}: account served by another core, 421 ${req.method} ${shownPath}`);
      const message = `adapter ${name}: account "${label}" is served by another core; use the same address built on coreUrl`;
      refuse(req, res, 421, 'wrong-core', message, placement.kind === 'remote' ? { coreUrl: placement.coreUrl } : {});
      return;
    }
    logger.warn(`[adapter-ingress] ${name}: account placement lookup failed ${req.method} ${shownPath}: ${placement.detail}`);
    refuse(req, res, 500, 'unexpected-error', `adapter ${name}: account placement unavailable`);
  }

  dispatch.refuseBeforeContinue = function refuseBeforeContinue (req: IncomingMessage, res: ServerResponse): boolean {
    const routed = routeOf(req);
    if (routed == null || !declaredTooLarge(req, routed.entry)) return false;
    logger.warn(`[adapter-ingress] ${routed.entry.route.name}: request body over ${routed.entry.route.maxBodyBytes} bytes refused before 100 Continue ${req.method} ${redactUrl(routed.url.pathname)}`);
    refuse(req, res, 413, 'invalid-request-structure', routed.entry.tooLarge);
    return true;
  };
  return dispatch;
}

/**
 * Lets a client that sent `Expect: 100-continue` learn of a 413 before it
 * uploads: an adapter request whose declared length is over its cap is refused
 * without `100 Continue`. Every other such request is told to continue and
 * goes through the server's request listeners, as Node does without this
 * listener (Socket.IO's included).
 */
function attachAdapterContinueCheck (server: ContinueServer, dispatch: AdapterDispatch, logger: Logger): void {
  server.on('checkContinue', (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (dispatch.refuseBeforeContinue(req, res)) return;
    } catch (err) {
      failIngress(req, res, err, logger, '[adapter-ingress]');
      return;
    }
    res.writeContinue();
    server.emit('request', req, res);
  });
}

export { buildAdapterIngress, attachAdapterContinueCheck, adapterAddressingFor };
export type { AdapterDispatch, AdapterAddressing };
