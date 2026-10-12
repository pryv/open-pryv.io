/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
const require = createRequire(import.meta.url);

const { getAPIVersion } = require('middleware/src/project_version.ts');
// Middleware to handle OPTIONS requests and to add CORS headers to all other
// requests.
export default async function (): Promise<RequestHandler> {
  const version = await getAPIVersion();
  return function (req: Request, res: Response, next: NextFunction) {
    // allow cross-domain requests (CORS)
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    // *
    res.header('Access-Control-Allow-Methods', req.headers['access-control-request-method'] ||
            'POST, GET, PUT, DELETE, OPTIONS');
    // *
    res.header('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] ||
            'Authorization, Content-Type');
    res.header('Access-Control-Expose-Headers', 'API-Version');
    // *
    res.header('Access-Control-Max-Age', (60 * 60 * 24 * 365).toString());
    res.header('Access-Control-Allow-Credentials', 'true');
    // The CORS headers above echo the request: a shared cache must key its
    // copies on what they echo.
    res.vary('Origin');
    if (req.method === 'OPTIONS') {
      res.vary('Access-Control-Request-Method');
      res.vary('Access-Control-Request-Headers');
    }
    // keep API version in HTTP headers for now
    res.header('API-Version', version);
    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    noStoreForJson(res);
    next();
  };
};

/**
 * API answers in JSON are never stored by a cache (they are per account and
 * often carry tokens). Applied when the headers are sent, once the content
 * type is known; an answer that set its own Cache-Control keeps it.
 */
function noStoreForJson (res: Response): void {
  const writeHead = res.writeHead;
  res.writeHead = function (this: Response, ...args: unknown[]) {
    if (!res.hasHeader('Cache-Control') && isJson(res.getHeader('Content-Type'))) {
      res.setHeader('Cache-Control', 'no-store');
    }
    return (writeHead as (...a: unknown[]) => Response).apply(this, args);
  } as Response['writeHead'];
}

function isJson (contentType: unknown): boolean {
  return typeof contentType === 'string' && /^application\/json\b/i.test(contentType);
}
