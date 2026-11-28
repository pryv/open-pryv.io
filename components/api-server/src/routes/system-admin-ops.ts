/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { Application } from 'express';

/**
 * Operations routes reached with an administrator session: invitation
 * tokens, observability settings, DNS records. Each route has its entry in
 * `systemRoutes/invitations.ts`, `systemRoutes/observability.ts` or
 * `systemRoutes/dns.ts`; the /system gate authenticates the caller first.
 * Methods in `methods/systemAdminOps.ts`, method ids declared in
 * `audit/src/apiMethods/adminOps.ts`.
 *
 * Mounts nothing in this release.
 */
export default function systemAdminOps (_expressApp: Application, _app: { systemAPI: { call: (...args: unknown[]) => unknown } }): void {
  // no route yet
}
