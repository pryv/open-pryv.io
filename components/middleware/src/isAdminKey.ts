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
