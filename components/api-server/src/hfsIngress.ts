/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * In-process HFS ingress dispatcher.
 *
 * Raw deploys (master.js terminating TLS on :443 in-process) have no
 * external ingress layer to route HF series traffic from the public
 * HTTPS listener to the HFS worker on http://localhost:4000. This
 * module is that routing layer.
 *
 * Two URL families go to HFS:
 *   - POST /<user>/events/<id>/series   (HF data-point ingest)
 *   - POST /<user>/series/batch          (HF batch ingest)
 *
 * Everything else falls through to the api-server's express app.
 *
 * For high-throughput production traffic profiles, front master.js
 * with nginx instead (see `docs/nginx-ingress-sample.conf`). This
 * in-process proxy is the "out-of-the-box" path; nginx is the
 * long-term efficient path.
 */

const http = require('http');

const HFS_SERIES_RE = /^\/[^/]+\/events\/[^/]+\/series(?:\/|\?|$)/;
const HFS_BATCH_RE = /^\/[^/]+\/series\/batch(?:\/|\?|$)/;

function isHfsPath (url: string): boolean {
  return HFS_SERIES_RE.test(url) || HFS_BATCH_RE.test(url);
}

/**
 * Build a request dispatcher closing over a logger + the HFS target.
 * Returns `(req, res, fallback) => void`. The caller invokes the
 * returned function from its top-level https/http request handler;
 * if the request matches an HFS path the dispatcher proxies it,
 * otherwise it invokes `fallback(req, res)` to pass to express.
 */
function buildHfsIngress (opts: { hfsHost: string, hfsPort: number, logger: any }) {
  const { hfsHost, hfsPort, logger } = opts;

  function proxy (req: any, res: any): void {
    const proxyReq = http.request({
      host: hfsHost,
      port: hfsPort,
      method: req.method,
      path: req.url,
      headers: req.headers
    }, (proxyRes: any) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (err: any) => {
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
    req.pipe(proxyReq);
  }

  return function dispatch (req: any, res: any, fallback: (req: any, res: any) => void): void {
    if (req.url && isHfsPath(req.url)) {
      proxy(req, res);
      return;
    }
    fallback(req, res);
  };
}

export { buildHfsIngress, isHfsPath };
