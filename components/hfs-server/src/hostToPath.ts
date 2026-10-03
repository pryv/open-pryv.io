/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import * as middleware from 'middleware';
import { usernameInHost, ignoredUsernameSubdomains } from 'business/src/usernameSubdomains.ts';

type ConfigReader = { get: (key: string) => unknown };

/**
 * The username-rewriter for the HFS worker, chosen exactly as the API server
 * chooses its own: none in dnsLess mode (the username is in the path and the
 * host is the core's public name), and the same ignored subdomains otherwise.
 * The API server forwards series requests here with the client's Host, so a
 * rewriter that ran unconditionally turned `/alice/events/<id>/series` on
 * `api-core1.example.com` into `/api-core1/alice/...` and answered 404.
 */
function hostToPath (config: ConfigReader): RequestHandler {
  if (!usernameInHost(config)) {
    return function noHostToPath (req: Request, res: Response, next: NextFunction) { next(); };
  }
  return middleware.subdomainToPath([], ignoredUsernameSubdomains(config));
}

export { hostToPath };
