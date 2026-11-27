/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { Application } from 'express';

/**
 * Platform-wide configuration routes (values held in the platform store).
 * Each route has its entry in `systemRoutes/platformConfig.ts`; the /system
 * gate authenticated the caller first. None yet.
 */
export default function systemAdminConfig (_expressApp: Application, _app: { systemAPI: { call: (...args: unknown[]) => unknown } }): void {
  // routes of this area are added here
}
