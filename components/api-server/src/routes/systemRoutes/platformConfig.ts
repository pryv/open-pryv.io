/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { SystemRouteEntry } from './common.ts';

/**
 * Route table entries of the platform-wide configuration held in the
 * platform store, served by `../system-admin-config.ts`. None is break-glass.
 */
export const PLATFORM_CONFIG_ROUTES: readonly SystemRouteEntry[] = Object.freeze([
  { method: 'GET', path: '/system/admin/platform-config', methodId: 'system.platformConfig.list', rule: { auth: 'admin', permission: 'config:read' } },
  { method: 'GET', path: '/system/admin/platform-config/:key', methodId: 'system.platformConfig.get', rule: { auth: 'admin', permission: 'config:read' } },
  { method: 'PUT', path: '/system/admin/platform-config/:key', methodId: 'system.platformConfig.set', rule: { auth: 'admin', permission: 'config:write' } },
  { method: 'DELETE', path: '/system/admin/platform-config/:key', methodId: 'system.platformConfig.delete', rule: { auth: 'admin', permission: 'config:write' } }
] as SystemRouteEntry[]);
