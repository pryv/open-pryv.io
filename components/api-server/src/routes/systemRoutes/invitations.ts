/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { SystemRouteEntry } from './common.ts';

/**
 * Route table entries of the invitation tokens reached with an administrator
 * session (`invitations:read`, `invitations:write`), served by
 * `../system-admin-ops.ts`. The legacy `/reg/admin/invitations*` routes keep
 * the admin key and are not listed here.
 *
 * Empty in this release: no route yet.
 */
export const INVITATION_ROUTES: readonly SystemRouteEntry[] = Object.freeze([] as SystemRouteEntry[]);
