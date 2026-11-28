/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Methods of the operations routes reached with an administrator session
 * (routes in routes/system-admin-ops.ts, method ids declared in
 * audit/src/apiMethods/adminOps.ts): invitation tokens, observability
 * settings, DNS records.
 *
 * Registers nothing in this release.
 */
export default async function (_systemAPI: { register: (...args: unknown[]) => void }): Promise<void> {
  // no method yet
}
