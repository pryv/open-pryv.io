/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream';
import type { Logger } from '@pryv/boiler';
import type { ClientRequest, IncomingMessage, ServerResponse } from 'http';
const require = createRequire(import.meta.url);

/**
 * In-process HFS ingress dispatcher.
 *
 * Raw deploys (master.js terminating TLS on :443 in-process) have no
 * external ingress layer to route HF series traffic from the public
 * HTTPS listener to the HFS worker on http://localhost:4000. This
 * module is that routing layer.
 *
 * Two URL families go to HFS (any method: ingest by POST, query by GET):
 *   - /<user>/events/<id>/series   (HF data points)
 *   - /<user>/series/batch          (HF batch ingest)
 *
 * Everything else falls through to the api-server's express app.
 *
 * For high-throughput production traffic profiles, front master.js
 * with nginx instead (see `docs/nginx-ingress-sample.conf`). This
 * in-process proxy is the "out-of-the-box" path; nginx is the
 * long-term efficient path.
 */

const http = require('http');

// Idle time on the worker connection in either direction; 60 s matches
// nginx's default proxy_read_timeout / proxy_send_timeout, which the
// documented nginx front applies to the same traffic.
const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 60_000;

// Two URL shapes per deployment topology:
// - dnsLess (one core, one FQDN, username in path): /<user>/events/<id>/series
// - subdomain-per-user (e.g. pryv.me's {username}.pryv.me): /events/<id>/series
// HFS server has a subdomainToPath middleware that extracts the
// username from the Host header in the subdomain case, so we don't
// need to massage the URL — just route the request as-is. Match both.
const HFS_SERIES_RE = /^\/(?:[^/]+\/)?events\/[^/]+\/series(?:\/|\?|$)/;
const HFS_BATCH_RE = /^\/(?:[^/]+\/)?series\/batch(?:\/|\?|$)/;

function isHfsPath (url: string): boolean {
  return HFS_SERIES_RE.test(url) || HFS_BATCH_RE.test(url);
}

/**
 * Build a request dispatcher closing over a logger + the HFS target.
 * Returns `(req, res, fallback) => void`. The caller invokes the
 * returned function from its top-level https/http request handler;
 * if the request matches an HFS path the dispatcher proxies it,
 * otherwise it invokes `fallback(req, res)` to pass to express.
 *
 * `upstreamIdleTimeoutMs` exists for tests; deployments use the default.
 */

function buildHfsIngress (opts: { hfsHost: string, hfsPort: number, logger: Logger, upstreamIdleTimeoutMs?: number }) {
  const { hfsHost, hfsPort, logger } = opts;
  const upstreamIdleTimeoutMs = opts.upstreamIdleTimeoutMs ?? DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS;

  function proxy (req: IncomingMessage, res: ServerResponse): void {
    const proxyReq: ClientRequest = http.request({
      host: hfsHost,
      port: hfsPort,
      method: req.method,
      path: req.url,
      headers: req.headers
    }, (proxyRes: IncomingMessage) => {
      // The client may have left while the worker was still working on the
      // request (its body was complete, so the request-side hook below did not
      // fire). Nothing to answer: release the worker's answer now rather than
      // writing headers onto a gone response (pipeline() below would also tear
      // it down, this just does not rely on it).
      if (res.destroyed) {
        proxyRes.destroy();
        return;
      }
      res.writeHead(proxyRes.statusCode ?? 500, proxyRes.headers);
      // Only writes refresh the worker socket's idle timer: the HTTP parser
      // reads the socket natively. Re-arm it per answer chunk, or a long answer
      // whose bytes keep flowing would be cut as if the worker were silent.
      proxyRes.on('data', () => { proxyReq.setTimeout(upstreamIdleTimeoutMs); });
      // pipeline(), not .pipe(): a client that goes away mid-answer must reach the
      // upstream response and its socket, and an upstream that dies mid-answer
      // must end this response instead of leaving it open.
      pipeline(proxyRes, res, (err: NodeJS.ErrnoException | null) => {
        if (err != null) {
          logger.debug(`[hfs-ingress] response hop ended early ${req.method} ${req.url}: ${err.code ?? err.message}`);
        }
      });
    });

    let upstreamTimedOut = false;
    // Socket idle timer: refreshed by every read and write on the worker
    // connection, so flowing uploads and answers are never cut; a silent worker is.
    proxyReq.setTimeout(upstreamIdleTimeoutMs, () => {
      // Nobody to answer: the client left after its body completed and the
      // worker never answered.
      if (res.destroyed) {
        proxyReq.destroy();
        return;
      }
      // Set before destroying: the destroy reports 'socket hang up' to the
      // error handler, which must not take it for an upstream failure. The 504
      // has usually closed the response by then (so `res.destroyed` alone would
      // catch it), but the flag does not depend on that ordering.
      upstreamTimedOut = true;
      logger.warn(`[hfs-ingress] upstream idle for ${upstreamIdleTimeoutMs} ms ${req.method} ${req.url}`);
      proxyReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            id: 'unexpected-error',
            message: 'HFS upstream timed out'
          }
        }));
      } else {
        res.destroy();
      }
    });

    proxyReq.on('error', (err: Error) => {
      if (upstreamTimedOut || res.destroyed) {
        // Most often the proxy's own teardown (a timeout, or a client that went
        // away), which Node reports as 'socket hang up'. Nothing to answer.
        logger.debug(`[hfs-ingress] upstream request dropped (${upstreamTimedOut ? 'timed out' : 'client went away'}) ${req.method} ${req.url}: ${err.message}`);
        return;
      }
      logger.warn(`[hfs-ingress] upstream error ${req.method} ${req.url}: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            id: 'unexpected-error',
            message: 'HFS upstream unreachable'
          }
        }));
      } else {
        res.destroy();
      }
    });

    // Request hop: .pipe() ends the upstream request only on 'end'. A client that
    // goes away mid-body closes `req` without 'end' and would leave the upstream
    // request half-open until the worker's request timeout. .pipe() is kept here
    // (not pipeline()): an upstream failure while the body is still arriving must
    // still answer 502, and pipeline() would destroy `req` and the client's socket
    // with it. Keyed on `req`, not `res`: the response may legitimately finish
    // before the upload does (an early 4xx), and the upload must keep flowing.
    req.once('close', () => {
      if (!req.complete) { proxyReq.destroy(); }
    });
    req.pipe(proxyReq);
  }

  return function dispatch (req: IncomingMessage, res: ServerResponse, fallback: (req: IncomingMessage, res: ServerResponse) => void): void {
    if (req.url && isHfsPath(req.url)) {
      proxy(req, res);
      return;
    }
    fallback(req, res);
  };
}

export { buildHfsIngress, isHfsPath };
