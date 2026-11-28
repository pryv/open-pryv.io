/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { SystemRouteEntry } from './common.ts';

/**
 * Route table entries of the observability settings reached with an
 * administrator session (`observability:read`, `observability:write`),
 * served by `../system-admin-ops.ts`. `bin/observability.js` stays the way
 * to set them from a shell.
 *
 * Empty in this release: no route yet.
 */
export const OBSERVABILITY_ROUTES: readonly SystemRouteEntry[] = Object.freeze([] as SystemRouteEntry[]);
