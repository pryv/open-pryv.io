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
 *
 * The grant is not break-glass: a role given by the admin key is what
 * break-glass keeps the key from doing. `roles:grant` is a step-up
 * permission and a platform-only write (a grant at scope `platform` gives it).
 */
export const ROLE_ROUTES: readonly SystemRouteEntry[] = Object.freeze([
  { method: 'GET', path: '/system/admin/roles/by-username/:username', methodId: 'system.roles.getByUsername', rule: { auth: 'admin', permission: 'roles:read' } },
  { method: 'GET', path: '/system/admin/roles/:userId', methodId: 'system.roles.get', rule: { auth: 'admin', permission: 'roles:read', breakGlass: true } },
  { method: 'PUT', path: '/system/admin/roles/:userId', methodId: 'system.roles.set', rule: { auth: 'admin', permission: 'roles:grant' } }
] as SystemRouteEntry[]);
