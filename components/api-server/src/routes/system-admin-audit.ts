/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { Application } from 'express';

/**
 * Administration audit trail routes. Each route has its entry in
 * `systemRoutes/audit.ts`; the /system gate authenticated the caller first.
 * None yet.
 */
export default function systemAdminAudit (_expressApp: Application, _app: { systemAPI: { call: (...args: unknown[]) => unknown } }): void {
  // routes of this area are added here
}
