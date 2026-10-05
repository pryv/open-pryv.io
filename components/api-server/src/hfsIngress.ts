/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { Logger } from '@pryv/boiler';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildWorkerProxy } from './workerIngress.ts';

/**
 * In-process HFS ingress dispatcher.
 *
 * Raw deploys (master.js terminating TLS on :443 in-process) have no
 * external ingress layer to route HF series traffic from the public
 * HTTPS listener to the HFS worker on http://localhost:4000. This
 * module is that routing layer (the proxy itself is `workerIngress.ts`).
 *
 * Two URL families go to HFS (any method: ingest by POST, query by GET):
 *   - /<user>/events/<id>/series   (HF data points)
 *   - /<user>/series/batch          (HF batch ingest)
 *
 * Everything else falls through to the api-server's express app.
 */

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
  const proxy = buildWorkerProxy({
    name: 'hfs',
    label: 'HFS',
    host: opts.hfsHost,
    port: opts.hfsPort,
    logger: opts.logger,
    upstreamIdleTimeoutMs: opts.upstreamIdleTimeoutMs
  });

  return function dispatch (req: IncomingMessage, res: ServerResponse, fallback: (req: IncomingMessage, res: ServerResponse) => void): void {
    if (req.url && isHfsPath(req.url)) {
      proxy(req, res, req.url);
      return;
    }
    fallback(req, res);
  };
}

export { buildHfsIngress, isHfsPath };
