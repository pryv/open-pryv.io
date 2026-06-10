/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Request, Response, NextFunction } from 'express';
const require = createRequire(import.meta.url);

// Express middleware that makes sure we have a continuation local storage
// context for each express request.
const cls = require('../cls.ts').default;
function clsWrap (req: Request, res: Response, next: NextFunction) {
  return cls.startExpressContext(req, res, next);
}
function factory () {
  return clsWrap;
}
export default factory;
