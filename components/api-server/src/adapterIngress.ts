/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '@pryv/boiler';
import type { AdapterRoute } from 'business/src/adapterRoutes.ts';
import { redactUrl } from 'utils/src/redactUrl.ts';
import { hasEncodedSeparatorOrDotSegment } from './ingressGuard.ts';
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
type Entry = { route: AdapterRoute; prefix: string; proxy: Proxy };

const JSON_ERROR_HEADERS = { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };

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
    const proxy = buildWorkerProxy({
      name: 'adapter',
      label: `adapter ${route.name}`,
      host: route.hostname,
      port: route.port,
      protocol: route.protocol,
      ca: opts.ca,
      logger,
      upstreamIdleTimeoutMs: route.idleTimeoutMs,
      stripHopByHop: true,
      forwardedHeaders: 'adapter',
      maxBodyBytes: route.maxBodyBytes,
      messages: {
        timedOut: `adapter ${route.name} timed out`,
        unreachable: `adapter ${route.name} unreachable`,
        tooLarge: `request body exceeds adapterRoutes.${route.name}.maxBodyBytes (${route.maxBodyBytes} bytes)`
      },
      logPathOnly: true,
      releaseOnClientClose: true
    });
    for (const prefix of route.paths) entries.push({ route, prefix, proxy });
  }

  function match (pathname: string): Entry | null {
    for (const entry of entries) {
      if (pathname === entry.prefix.slice(0, -1) || pathname.startsWith(entry.prefix)) return entry;
    }
    return null;
  }

  return function dispatch (req: IncomingMessage, res: ServerResponse, fallback: Fallback): void {
    // Origin-form only: prefixing keeps `//x/y` a path instead of a host.
    if (entries.length === 0 || req.url == null || !req.url.startsWith('/')) {
      fallback(req, res);
      return;
    }
    let url: URL;
    try { url = new URL('http://placeholder' + req.url); } catch { fallback(req, res); return; }
    // Matched on the normalised path (dot segments resolved, `\` read as `/`),
    // which is also the path forwarded: a raw path that normalises outside the
    // prefix never reaches the upstream.
    const entry = match(url.pathname);
    if (entry == null) {
      fallback(req, res);
      return;
    }
    const started = Date.now();
    const shownPath = redactUrl(url.pathname);
    if (hasEncodedSeparatorOrDotSegment(url.pathname) || /%00/.test(url.pathname)) {
      logger.warn(`[adapter-ingress] ${entry.route.name}: encoded separator or dot segment refused ${req.method} ${shownPath}`);
      req.resume();
      res.writeHead(400, JSON_ERROR_HEADERS);
      res.end(JSON.stringify({ error: { id: 'invalid-request-structure', message: `adapter ${entry.route.name}: encoded separators and dot segments are not accepted in the path` } }));
      return;
    }
    res.once('close', () => {
      logger.debug(`[adapter-ingress] ${entry.route.name} ${req.method} ${shownPath} ${res.statusCode}${res.writableFinished ? '' : ' (not finished)'} ${Date.now() - started} ms`);
    });
    entry.proxy(req, res, url.pathname + rawSearchOf(req.url));
  };
}

export { buildAdapterIngress };
