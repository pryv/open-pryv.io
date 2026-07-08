/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Request, Response, NextFunction } from 'express';
const require = createRequire(import.meta.url);

const { DummyTracing } = require('tracing');

type ContextSource = { name: string; ip: string };
type UserSlot = { id: string | undefined | null; username: string };
type MinimalContextRequest = Request & {
  context?: unknown;
  tracing?: unknown;
  connection: { remoteAddress?: string };
};

class MinimalMethodContext {
  source: ContextSource;

  user?: UserSlot;

  username?: string;

  access?: unknown;

  originalQuery: Record<string, unknown>;

  _tracing: unknown;
  constructor (req: MinimalContextRequest) {
    const xff = req.headers['x-forwarded-for'];
    this.source = {
      name: 'http',
      ip: (Array.isArray(xff) ? xff[0] : xff) || req.connection.remoteAddress || ''
    };
    this.originalQuery = structuredClone(req.query) as Record<string, unknown>;
    if (this.originalQuery?.auth) { delete this.originalQuery.auth; }
    this._tracing = req.tracing;
  }

  get tracing (): unknown {
    if (this._tracing == null) {
      this._tracing = new DummyTracing();
    }
    return this._tracing;
  }

  set tracing (tracing: unknown) {
    this._tracing = tracing;
  }
}
/**
 * Helper for express to set a Minimal Context, for methods that does use the standard MethodContext.
 * Note: will have no effect is a context already exists.
 */
function setMinimalMethodContext (req: MinimalContextRequest, res: Response, next: NextFunction): void {
  if (req.context) {
    return next(new Error('Context already set'));
  }
  req.context = new MinimalMethodContext(req);
  next();
}
export default setMinimalMethodContext;
