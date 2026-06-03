/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Request, Response, NextFunction } from 'express';
import type { CustomAuthFunction } from 'business/src/MethodContext.ts';
const require = createRequire(import.meta.url);

const { MethodContext } = require('business');

type PryvRequest = Request & { context?: { init: () => Promise<unknown> }; tracing?: unknown };
// Returns a middleware function that initializes the method context into
// `req.context`. The context is initialized with the user (loaded from
// username) and the access token. the access itself is **not** loaded from
// token here as it may be modified in the course of method execution, for
// example when calling a batch of methods. it is the api methods'
// responsibility to load the access when needed.
//
export default function initContext (storageLayer: unknown, customAuthStepFn: CustomAuthFunction) {
  return function (req: PryvRequest, res: Response, next: NextFunction) {
    const authorizationHeader = req.headers.authorization;
    const contextSource = {
      name: 'http',
      ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress
    };
    // We should not do this, but we're doing it.
    req.context = new MethodContext(contextSource, req.params.username, authorizationHeader, customAuthStepFn, req.headers, req.query, req.tracing);
    // Convert the above promise into a callback.
    return req.context!
      .init()
      .then(() => next())
      .catch(next);
  };
};
