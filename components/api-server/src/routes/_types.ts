/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { Request } from 'express';
import type { ConfigLike } from '@pryv/boiler';
import type { MethodContext } from 'business/src/MethodContext.ts';

// The Application instance as route modules see it (structural subset of
// api-server/src/application.ts — routes only touch these members).
type AppLike = {
  api: { call: (...args: unknown[]) => unknown };
  config: ConfigLike;
  storageLayer: unknown;
  getCustomAuthFunction: (name: string) => unknown;
};

// Request after the initContext middleware attached the method context.
// `files` is landed by the uploads middleware on multipart routes.
type PryvRequest = Request & { context?: MethodContext; files?: unknown };

export type { AppLike, PryvRequest };
