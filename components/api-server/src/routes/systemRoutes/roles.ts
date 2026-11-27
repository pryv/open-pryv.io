/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { SystemRouteEntry } from './common.ts';

/**
 * Route table entries of role management (grant, read one account's roles,
 * look an account up by username), served by `../system-admin-roles.ts`.
 * The claim-code and role list / revocation routes stay in the main list.
 */
export const ROLE_ROUTES: readonly SystemRouteEntry[] = Object.freeze([] as SystemRouteEntry[]);
