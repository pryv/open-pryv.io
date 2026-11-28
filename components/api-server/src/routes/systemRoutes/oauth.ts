/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { SystemRouteEntry } from './common.ts';

/**
 * Route table entries of the OAuth client and publisher review, served by
 * `../system-admin-oauth.ts`.
 *
 * None is break-glass (the admin key reaches them in scope `full` only), none
 * asks for a second factor (each act is reversible and recorded). The gate
 * checks the permission; each method then keeps to the rows the caller's
 * replicated grants holding that permission cover by region (scope
 * `platform`, or `region:<r>` covering every region the row lists; a row
 * listing none needs `platform`). Other rows answer 404, as a missing
 * permission does.
 */
export const OAUTH_ROUTES: readonly SystemRouteEntry[] = Object.freeze([
  { method: 'GET', path: '/system/admin/oauth/clients', methodId: 'system.oauthClients.list', rule: { auth: 'admin', permission: 'oauthClients:read' } },
  { method: 'GET', path: '/system/admin/oauth/clients/:clientId', methodId: 'system.oauthClients.get', rule: { auth: 'admin', permission: 'oauthClients:read' } },
  { method: 'POST', path: '/system/admin/oauth/clients/:clientId/approve', methodId: 'system.oauthClients.approve', rule: { auth: 'admin', permission: 'oauthClients:review' } },
  { method: 'POST', path: '/system/admin/oauth/clients/:clientId/unvalidate', methodId: 'system.oauthClients.unvalidate', rule: { auth: 'admin', permission: 'oauthClients:review' } },
  { method: 'POST', path: '/system/admin/oauth/clients/:clientId/suspend', methodId: 'system.oauthClients.suspend', rule: { auth: 'admin', permission: 'oauthClients:review' } },
  { method: 'POST', path: '/system/admin/oauth/clients/:clientId/resume', methodId: 'system.oauthClients.resume', rule: { auth: 'admin', permission: 'oauthClients:review' } },
  { method: 'GET', path: '/system/admin/oauth/publishers', methodId: 'system.publishers.list', rule: { auth: 'admin', permission: 'publishers:read' } },
  { method: 'GET', path: '/system/admin/oauth/publishers/:userId', methodId: 'system.publishers.get', rule: { auth: 'admin', permission: 'publishers:read' } },
  { method: 'PUT', path: '/system/admin/oauth/publishers/:userId', methodId: 'system.publishers.set', rule: { auth: 'admin', permission: 'publishers:review' } }
] as SystemRouteEntry[]);
