/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { timingSafeEqual } from 'node:crypto';

/**
 * Whether `sent` (the raw `Authorization` header) is the configured admin key
 * (`auth.adminAccessKey`), compared in constant time. No key configured
 * refuses everything.
 */
export default function isAdminKey (sent: unknown, adminAccessKey: unknown): boolean {
  if (typeof sent !== 'string' || typeof adminAccessKey !== 'string' || adminAccessKey === '') return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(adminAccessKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * For an admin-key route outside `/system` that is not a break-glass one
 * (account deletion, `/reg/records`, the `/reg/admin` routes): whether `sent`
 * is the admin key AND the key's scope allows it. With
 * `auth.adminAccessKeyScope: break-glass` the key is refused there (an
 * administrator session or the account's own token is the way).
 */
export function isAdminKeyInFullScope (sent: unknown, config: { get: (key: string) => unknown }): boolean {
  if (config.get('auth:adminAccessKeyScope') === 'break-glass') return false;
  return isAdminKey(sent, config.get('auth:adminAccessKey'));
}
