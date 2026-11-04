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
import https from 'node:https';
import net from 'node:net';
import { pipeline } from 'node:stream';
import type { Logger } from '@pryv/boiler';
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { clientIp, trustedProxyFn } from 'middleware/src/clientIp.ts';
import { redactUrl } from 'utils/src/redactUrl.ts';
import { failIngress } from './ingressGuard.ts';

/**
 * Proxy core shared by the in-process dispatchers that route part of the
 * public port's traffic to a local worker (HFS series, image previews) or to
 * a sidecar on the same host (adapter routes).
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

/**
 * Hop-by-hop headers (RFC 7230 § 6.1), plus `proxy-connection` (legacy) and
 * `expect` (this server already answered `100 Continue`; the client would
 * wait on the upstream otherwise). Also every header `connection` names.
 */
const HOP_BY_HOP_REQUEST = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'expect'];
const HOP_BY_HOP_RESPONSE = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authenticate'];
/**
 * Headers a `Connection` token never removes: the message framing, the Host,
 * and the forwarding headers this proxy controls. A client listing
 * `content-length` there would otherwise send its body to the upstream
 * unframed, where it reads as a further request.
 */
const NEVER_DROPPED = new Set(['host', 'content-length', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']);

const JSON_ERROR_HEADERS = { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };

type WorkerProxyOptions = {
  /** Log prefix, e.g. `hfs` -> `[hfs-ingress]`. */
  name: string,
  /** Error message prefix seen by clients, e.g. `HFS` -> `HFS upstream timed out`. */
  label: string,
  host: string,
  port: number,
  logger: Logger,
  /** For tests; deployments use the default. */
  upstreamIdleTimeoutMs?: number,
  /** Upstream scheme; `http:` (the workers) unless set. */
  protocol?: 'http:' | 'https:',
  /** Trusted CA for an `https:` upstream; for tests (deployments use the system store). */
  ca?: string,
  /**
   * Remove the hop-by-hop headers in both directions and re-frame the body
   * (off for the workers: they are loopback peers that get every header).
   */
  stripHopByHop?: boolean,
  /**
   * `worker` (default): X-Forwarded-For set, X-Forwarded-Host / -Proto
   * dropped unless from a trusted peer. `adapter`: X-Forwarded-Host and
   * X-Forwarded-Proto also set from the request (a trusted peer's own values
   * are kept), `Forwarded` and `X-Forwarded-Port` removed.
   */
  forwardedHeaders?: 'worker' | 'adapter',
  /** Request body cap in bytes: past it the answer is 413. No cap unless set. */
  maxBodyBytes?: number,
  /** Client-facing error messages; the defaults name `label`. */
  messages?: { timedOut?: string, unreachable?: string, tooLarge?: string },
  /** Log the path without its query (the workers log the redacted URL). */
  logPathOnly?: boolean,
  /** Release the upstream request when the client leaves before the answer is complete. */
  releaseOnClientClose?: boolean,
  /** Agent for the upstream connections; the global agent unless set. */
  agent?: http.Agent
};

/** Headers named by `connection` (and the hop-by-hop list), lowercased. */
function hopByHopOf (headers: IncomingHttpHeaders, base: string[]): Set<string> {
  const names = new Set(base);
  const connection = headers.connection;
  const values = Array.isArray(connection) ? connection : (connection != null ? [connection] : []);
  for (const v of values) {
    for (const token of v.split(',')) {
      const t = token.trim().toLowerCase();
      if (t !== '' && !NEVER_DROPPED.has(t)) names.add(t);
    }
  }
  return names;
}

function withoutHopByHop (headers: IncomingHttpHeaders, base: string[]): IncomingHttpHeaders {
  const drop = hopByHopOf(headers, base);
  const out: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!drop.has(name)) out[name] = value;
  }
  return out;
}

/**
 * The upstream's response headers as it sent them: a header Node joined into
 * one `, `-separated line (several `WWW-Authenticate` challenges, `Link`)
 * goes back as separate lines. Headers Node keeps the first of (e.g.
 * `content-type`, `content-length`) stay single.
 */
function responseHeadersAsSent (proxyRes: IncomingMessage): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = { ...proxyRes.headers };
  for (const [name, values] of Object.entries(proxyRes.headersDistinct)) {
    const joined = out[name];
    if (values != null && values.length > 1 && typeof joined === 'string' && joined === values.join(', ')) out[name] = values;
  }
  return out;
}

function sendJsonError (res: ServerResponse, status: number, message: string, id: string, extra: Record<string, string> = {}) {
  res.writeHead(status, { ...JSON_ERROR_HEADERS, ...extra });
  res.end(JSON.stringify({ error: { id, message } }));
}

/**
 * Returns `proxy(req, res, targetPath)`: forwards the request to the worker
 * at `targetPath` (the path + query the worker expects) and pipes the answer
 * back, with the abort, stall and error handling every dispatcher needs.
 */
function buildWorkerProxy (opts: WorkerProxyOptions) {
  const { name, label, host, port, logger } = opts;
  const upstreamIdleTimeoutMs = opts.upstreamIdleTimeoutMs ?? DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS;
  const tag = `[${name}-ingress]`;
  const transport = opts.protocol === 'https:' ? https : http;
  // Without an explicit server name, Node takes the TLS server name from the
  // Host header (the client's public host): check the upstream's own instead.
  // An IP is verified against the certificate's IP entries ('' = no SNI).
  const tlsOptions = opts.protocol === 'https:'
    ? { servername: net.isIP(host) ? '' : host, ...(opts.ca != null ? { ca: opts.ca } : {}) }
    : {};
  const stripHopByHop = opts.stripHopByHop === true;
  const adapterHeaders = opts.forwardedHeaders === 'adapter';
  const maxBodyBytes = opts.maxBodyBytes;
  const messages = {
    timedOut: opts.messages?.timedOut ?? `${label} upstream timed out`,
    unreachable: opts.messages?.unreachable ?? `${label} upstream unreachable`,
    tooLarge: opts.messages?.tooLarge ?? `${label} request body too large`
  };

  return function proxy (req: IncomingMessage, res: ServerResponse, targetPath: string): void {
    const shownUrl = opts.logPathOnly === true ? redactUrl((req.url ?? '').replace(/[?#].*$/s, '')) : redactUrl(req.url);
    // The worker sees this hop as a loopback peer, which it trusts: hand it the
    // client address resolved here, never the client's own X-Forwarded-For.
    const headers: IncomingHttpHeaders = stripHopByHop ? withoutHopByHop(req.headers, HOP_BY_HOP_REQUEST) : { ...req.headers };
    const client = clientIp(req);
    if (client == null) delete headers['x-forwarded-for'];
    else headers['x-forwarded-for'] = client;
    // Host / scheme forwarding headers likewise only pass on from a trusted peer.
    const peer = req.socket?.remoteAddress;
    const trustedPeer = peer != null && trustedProxyFn()(peer, 0);
    if (!trustedPeer) {
      delete headers['x-forwarded-host'];
      delete headers['x-forwarded-proto'];
    }
    if (adapterHeaders) {
      // One convention, the X-Forwarded-* triple, always set by this core.
      delete headers.forwarded;
      delete headers['x-forwarded-port'];
      if (headers['x-forwarded-host'] == null && req.headers.host != null) headers['x-forwarded-host'] = req.headers.host;
      if (headers['x-forwarded-proto'] == null) headers['x-forwarded-proto'] = (req.socket as TLSSocket | undefined)?.encrypted === true ? 'https' : 'http';
    }
    // Framing is derived from the request as received, never from what is left
    // after the strip: the declared length as is, else a chunked body re-framed
    // as chunked whatever the method (Node frames only some methods by default,
    // and an unframed body would be read by the upstream as a next request).
    if (stripHopByHop) {
      if (req.headers['content-length'] != null) headers['content-length'] = req.headers['content-length'];
      else if (req.headers['transfer-encoding'] != null) headers['transfer-encoding'] = 'chunked';
    }

    let bodyTooLarge = false;
    const declaredLength = Number(req.headers['content-length']);
    if (maxBodyBytes != null && Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      // The upstream is not contacted; the client may still be sending.
      logger.warn(`${tag} request body over ${maxBodyBytes} bytes (content-length ${declaredLength}) ${req.method} ${shownUrl}`);
      req.resume();
      sendJsonError(res, 413, messages.tooLarge, 'invalid-request-structure', { connection: 'close' });
      return;
    }

    const proxyReq: ClientRequest = transport.request({
      host,
      port,
      method: req.method,
      path: targetPath,
      headers,
      ...(opts.agent != null ? { agent: opts.agent } : {}),
      ...tlsOptions
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
      try {
        res.writeHead(proxyRes.statusCode ?? 500, stripHopByHop ? withoutHopByHop(responseHeadersAsSent(proxyRes), HOP_BY_HOP_RESPONSE) : proxyRes.headers);
      } catch (err) {
        // A throw here is in the client request's callback: it would end the worker.
        proxyRes.destroy();
        failIngress(req, res, err, logger, tag);
        return;
      }
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
        sendJsonError(res, 504, messages.timedOut, 'unexpected-error');
      } else {
        res.destroy();
      }
    });

    proxyReq.on('error', (err: Error) => {
      if (upstreamTimedOut || bodyTooLarge || res.destroyed) {
        // Most often the proxy's own teardown (a timeout, a body cap, or a client
        // that went away), which Node reports as 'socket hang up'. Nothing to answer.
        logger.debug(`${tag} upstream request dropped (${upstreamTimedOut ? 'timed out' : (bodyTooLarge ? 'body too large' : 'client went away')}) ${req.method} ${shownUrl}: ${err.message}`);
        return;
      }
      logger.warn(`${tag} upstream error ${req.method} ${shownUrl}: ${err.message}`);
      if (!res.headersSent) {
        sendJsonError(res, 502, messages.unreachable, 'unexpected-error');
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
    if (opts.releaseOnClientClose === true) {
      // The client left before the answer was complete (e.g. a stream
      // subscriber): end the upstream request too, whether or not it answered.
      res.once('close', () => {
        if (!res.writableFinished) proxyReq.destroy();
      });
    }
    if (maxBodyBytes != null) {
      // A body without a declared length (chunked) is counted as it flows.
      // Registered before the pipe, so the chunk that crosses the cap is
      // seen here first and the upstream request is gone before it is written.
      let received = 0;
      const count = (chunk: Buffer) => {
        received += chunk.length;
        if (received <= maxBodyBytes || bodyTooLarge) return;
        bodyTooLarge = true;
        logger.warn(`${tag} request body over ${maxBodyBytes} bytes ${req.method} ${shownUrl}`);
        req.unpipe(proxyReq);
        req.removeListener('data', count);
        proxyReq.destroy();
        req.resume();
        if (!res.headersSent) sendJsonError(res, 413, messages.tooLarge, 'invalid-request-structure', { connection: 'close' });
        else res.destroy();
      };
      req.on('data', count);
    }
    req.pipe(proxyReq);
  };
}

export { buildWorkerProxy, redactUrl, DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS };
export type { WorkerProxyOptions };
