/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { Request } from 'express';
import type { ConfigLike } from '@pryv/boiler';

// The Application instance as route modules see it (structural subset of
// api-server/src/application.ts — routes only touch these members).
type AppLike = {
  api: { call: (...args: unknown[]) => unknown };
  config: ConfigLike;
  storageLayer: unknown;
  getCustomAuthFunction: (name: string) => unknown;
};

// Request after the initContext middleware attached the method context.
// Files that read specific context capabilities refine this locally.
type PryvRequest = Request & { context?: unknown };

export type { AppLike, PryvRequest };
