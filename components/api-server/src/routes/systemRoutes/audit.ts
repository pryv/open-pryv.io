/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { SystemRouteEntry } from './common.ts';

/**
 * Route table entries of the administration audit trail (its read route),
 * served by `../system-admin-audit.ts`.
 */
export const AUDIT_ROUTES: readonly SystemRouteEntry[] = Object.freeze([] as SystemRouteEntry[]);
