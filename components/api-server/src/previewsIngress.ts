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
 * In-process dispatcher for image previews: routes the public preview URL to
 * the previews worker (`http.previewsPort`, internal), as the HFS dispatcher
 * does for series. Without it, a core that terminates TLS itself answers 404
 * to every preview request.
 *
 * Client URL (the long-standing contract, `{apiEndpoint}previews/events/{id}`):
 *   - dnsLess:          /{user}/previews/events/{id}[.jpg|.jpeg]?w=&h=&auth=
 *   - username in host: /previews/events/{id}...   (or the dnsLess form)
 * The worker serves `/{user}/events/{id}` (or `/events/{id}` with the
 * username in the Host, which its own host rewrite moves into the path).
 *
 * In dnsLess mode the user segment is required: a user named `previews` keeps
 * `GET /previews/events/{id}` for its own API. `/previews/clean-up-cache` is
 * deliberately not routed: it is an internal maintenance call.
 */

const WITH_USER_RE = /^\/([^/?#]+)\/previews\/events\/([^/?#]+)(\?[^#]*)?$/;
const WITHOUT_USER_RE = /^\/previews\/events\/([^/?#]+)(\?[^#]*)?$/;

/**
 * The worker path for a public preview URL, or `null` when `url` is not one.
 */
function previewsTarget (url: string, opts: { usernameInHost: boolean }): string | null {
  const withUser = WITH_USER_RE.exec(url);
  if (withUser != null) return `/${withUser[1]}/events/${withUser[2]}${withUser[3] ?? ''}`;
  if (opts.usernameInHost) {
    const withoutUser = WITHOUT_USER_RE.exec(url);
    if (withoutUser != null) return `/events/${withoutUser[1]}${withoutUser[2] ?? ''}`;
  }
  return null;
}

/**
 * Returns `(req, res, fallback) => void`: proxies a preview URL to the worker,
 * anything else to `fallback` (the next dispatcher, then express).
 * `upstreamIdleTimeoutMs` exists for tests; deployments use the default.
 */
function buildPreviewsIngress (opts: { previewsHost: string, previewsPort: number, usernameInHost: boolean, logger: Logger, upstreamIdleTimeoutMs?: number }) {
  const proxy = buildWorkerProxy({
    name: 'previews',
    label: 'Previews',
    host: opts.previewsHost,
    port: opts.previewsPort,
    logger: opts.logger,
    upstreamIdleTimeoutMs: opts.upstreamIdleTimeoutMs
  });
  const usernameInHost = opts.usernameInHost;

  return function dispatch (req: IncomingMessage, res: ServerResponse, fallback: (req: IncomingMessage, res: ServerResponse) => void): void {
    const target = req.url ? previewsTarget(req.url, { usernameInHost }) : null;
    if (target != null) {
      proxy(req, res, target);
      return;
    }
    fallback(req, res);
  };
}

export { buildPreviewsIngress, previewsTarget };
