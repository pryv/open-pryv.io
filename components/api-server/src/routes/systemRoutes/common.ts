/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { AdminRouteRule } from 'middleware/src/adminAuth.ts';

/**
 * What every list of the `/system` route table is made of (see
 * `../system-permissions.ts`, which joins the lists).
 */

export type SystemRouteEntry = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  /** The API method id, when the route has one. */
  methodId: string | null;
  rule: AdminRouteRule;
};

/** Subject kinds a route accepts (`rule.accepts`), when not the default key and session. */
export const KEY_ONLY = ['key'] as const;
export const SESSION_ONLY = ['session'] as const;
export const SETUP_ONLY = ['setup'] as const;
export const WITH_SETUP = ['key', 'session', 'setup'] as const;
