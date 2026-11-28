/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { SystemRouteEntry } from './common.ts';

/**
 * Route table entries of the DNS records reached with an administrator
 * session (`dns:read`, `dns:write`), served by `../system-admin-ops.ts`.
 * `/reg/records` keeps the admin key and is not listed here.
 *
 * Empty in this release: no route yet.
 */
export const DNS_ROUTES: readonly SystemRouteEntry[] = Object.freeze([] as SystemRouteEntry[]);
