/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
// Default import (the CommonJS module object), not a namespace import: test
// tooling that patches http.request and later restores it (nock) only restores
// the CommonJS object, and a namespace binding can keep the wrapped function.
import http from 'node:http';
import { pipeline } from 'node:stream';
import type { Logger } from '@pryv/boiler';
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { clientIp, trustedProxyFn } from 'middleware/src/clientIp.ts';
import { redactUrl } from 'utils/src/redactUrl.ts';

/**
 * Proxy core shared by the in-process dispatchers that route part of the
 * public port's traffic to a local worker (HFS series, image previews).
 *
 * Raw deploys (master.js terminating TLS itself) have no external ingress
 * layer in front of the workers: these dispatchers are that layer. For
 * high-throughput traffic, front master.js with nginx instead (see
 * `docs/nginx-ingress-sample.conf`).
 */

// Idle time on the worker connection in either direction; 60 s matches
// nginx's default proxy_read_timeout / proxy_send_timeout, which the
// documented nginx front applies to the same traffic.
const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 60_000;

type WorkerProxyOptions = {
  /** Log prefix, e.g. `hfs` -> `[hfs-ingress]`. */
  name: string,
  /** Error message prefix seen by clients, e.g. `HFS` -> `HFS upstream timed out`. */
  label: string,
  host: string,
  port: number,
  logger: Logger,
  /** For tests; deployments use the default. */
  upstreamIdleTimeoutMs?: number
};

/**
 * Returns `proxy(req, res, targetPath)`: forwards the request to the worker
 * at `targetPath` (the path + query the worker expects) and pipes the answer
 * back, with the abort, stall and error handling every dispatcher needs.
 */
function buildWorkerProxy (opts: WorkerProxyOptions) {
  const { name, label, host, port, logger } = opts;
  const upstreamIdleTimeoutMs = opts.upstreamIdleTimeoutMs ?? DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS;
  const tag = `[${name}-ingress]`;

  return function proxy (req: IncomingMessage, res: ServerResponse, targetPath: string): void {
    const shownUrl = redactUrl(req.url);
    // The worker sees this hop as a loopback peer, which it trusts: hand it the
    // client address resolved here, never the client's own X-Forwarded-For.
    const headers: IncomingHttpHeaders = { ...req.headers };
    const client = clientIp(req);
    if (client == null) delete headers['x-forwarded-for'];
    else headers['x-forwarded-for'] = client;
    // Host / scheme forwarding headers likewise only pass on from a trusted peer.
    const peer = req.socket?.remoteAddress;
    if (peer == null || !trustedProxyFn()(peer, 0)) {
      delete headers['x-forwarded-host'];
      delete headers['x-forwarded-proto'];
    }
    const proxyReq: ClientRequest = http.request({
      host,
      port,
      method: req.method,
      path: targetPath,
      headers
    }, (proxyRes: IncomingMessage) => {
      // The client may have left while the worker was still working on the
      // request (its body was complete, so the request-side hook below did not
      // fire). Nothing to answer, and pipeline() throws synchronously on a
      // destroyed destination: an uncaught exception in the parser callback.
      if (res.destroyed) {
        proxyRes.destroy();
        return;
      }
      // The worker answered before the client's body was complete (e.g. an
      // access refused on a large batch). Once that answer ends, Node stops
      // watching the worker request for 'drain', so the client upload would stall
      // in `req.pipe(proxyReq)` until a request timeout. Do what Node's own server
      // does with an unread body: stop forwarding it, discard the rest so the
      // client can finish, and release the worker request.
      proxyRes.once('end', () => {
        if (!req.complete) {
          req.unpipe(proxyReq);
          proxyReq.destroy();
          req.resume();
        }
      });
      res.writeHead(proxyRes.statusCode ?? 500, proxyRes.headers);
      // pipeline(), not .pipe(): a client that goes away mid-answer must reach the
      // upstream response and its socket, and an upstream that dies mid-answer
      // must end this response instead of leaving it open.
      pipeline(proxyRes, res, (err: NodeJS.ErrnoException | null) => {
        if (err != null) {
          logger.debug(`${tag} response hop ended early ${req.method} ${shownUrl}: ${err.code ?? err.message}`);
        }
      });
    });

    let upstreamTimedOut = false;
    // Socket idle timer: refreshed by every read and write on the worker
    // connection, so flowing uploads and answers are never cut; a silent worker
    // is, and so is a client that stops sending or reading for the whole window.
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
      logger.warn(`${tag} no data moved on the worker connection for ${upstreamIdleTimeoutMs} ms${res.writableNeedDrain ? ' (client not reading)' : ''} ${req.method} ${shownUrl}`);
      proxyReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' });
        res.end(JSON.stringify({
          error: {
            id: 'unexpected-error',
            message: `${label} upstream timed out`
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
        logger.debug(`${tag} upstream request dropped (${upstreamTimedOut ? 'timed out' : 'client went away'}) ${req.method} ${shownUrl}: ${err.message}`);
        return;
      }
      logger.warn(`${tag} upstream error ${req.method} ${shownUrl}: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' });
        res.end(JSON.stringify({
          error: {
            id: 'unexpected-error',
            message: `${label} upstream unreachable`
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
  };
}

export { buildWorkerProxy, redactUrl, DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS };
export type { WorkerProxyOptions };
