/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { Request, Response, NextFunction } from 'express';

/**
 * Forbids MIME sniffing on every answer. Mount it first, so the answers to
 * errors raised by later middleware (e.g. the body parsers) carry it too.
 */
export default function noSniff (_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}
