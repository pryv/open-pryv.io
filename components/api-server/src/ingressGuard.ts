/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '@pryv/boiler';
import { redactUrl } from 'utils/src/redactUrl.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;

/**
 * Answers 500 (or closes the connection when the answer has started) instead
 * of letting a throw end the worker. The raw ingress runs before express, so
 * nothing else catches a synchronous throw there (e.g. `setHeader` refusing a
 * value) or a rejection of its async branches.
 */
export function failIngress (req: IncomingMessage, res: ServerResponse, err: unknown, logger: Logger, tag = '[ingress]'): void {
  logger.error(`${tag} ${req.method} ${redactUrl(req.url ?? '')}: ${err instanceof Error ? err.message : String(err)}`);
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  try {
    for (const name of res.getHeaderNames()) res.removeHeader(name);
    const body = JSON.stringify({ error: { id: 'unexpected-error', message: 'Unexpected error' } });
    res.writeHead(500, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store'
    });
    res.end(body);
  } catch (e) {
    res.destroy();
  }
}

export function guardIngress (handler: Handler, logger: Logger): Handler {
  return function guardedIngress (req: IncomingMessage, res: ServerResponse) {
    try {
      const result = handler(req, res);
      if (result != null && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).catch((err: unknown) => failIngress(req, res, err, logger));
      }
    } catch (err) {
      failIngress(req, res, err, logger);
    }
  };
}
