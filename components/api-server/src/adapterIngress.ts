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
import { failIngress, hasEncodedSeparatorOrDotSegment } from './ingressGuard.ts';
import { buildWorkerProxy } from './workerIngress.ts';

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

const JSON_ERROR_HEADERS = { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };

/**
 * A refusal before the body was read: the connection is closed after it, so
 * an unread (possibly unbounded) body is not drained over keep-alive.
 */
function refuse (req: IncomingMessage, res: ServerResponse, status: number, id: string, message: string) {
  req.resume();
  res.writeHead(status, { ...JSON_ERROR_HEADERS, connection: 'close' });
  res.end(JSON.stringify({ error: { id, message } }));
}

/** The query of a request target as received (from `?`, without a fragment). */
function rawSearchOf (url: string): string {
  const hashAt = url.indexOf('#');
  const target = hashAt < 0 ? url : url.slice(0, hashAt);
  const queryAt = target.indexOf('?');
  return queryAt < 0 ? '' : target.slice(queryAt);
}

function buildAdapterIngress (opts: { routes: Map<string, AdapterRoute>; logger: Logger; ca?: string }) {
  const { routes, logger } = opts;
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
    entry.proxy(req, res, url.pathname + rawSearchOf(req.url as string));
  } as AdapterDispatch;

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

export { buildAdapterIngress, attachAdapterContinueCheck };
export type { AdapterDispatch };
