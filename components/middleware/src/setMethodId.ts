/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Request, Response, NextFunction } from 'express';
const require = createRequire(import.meta.url);

const { initRootSpan } = require('tracing');

type PryvRequest = Request & { context?: { tracing?: { finishSpan: (...a: unknown[]) => void }; methodId?: string } };

/**
 * Sets the methodId to the Request.context object of the Express stack
 */
export default function (methodId: string) {
  return function setMethodId (req: PryvRequest, res: Response, next: NextFunction) {
    if (req.context == null) {
      const tracing = initRootSpan('express2');
      req.context = { tracing };
      res.on('finish', () => {
        tracing.finishSpan('express2', 'e2:' + methodId);
      });
    }
    req.context.methodId = methodId;
    next();
  };
};
