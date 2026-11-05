/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Mail to an account's stored email, when the platform reserves that address
 * for ANOTHER account (it changed hands after the account stored it, e.g. an
 * account restored from an older backup): the address is not taken to be this
 * account's inbox, and nothing about the account is mailed to it. The platform
 * row is trusted as is: whether its holder proved the address is not checked
 * (registration does not prove it by default).
 *
 * Shared by the senders to the stored email (the password reset, the MFA
 * change notice, the auto-deletion notices), the restore report and the email
 * row reconcile.
 */

import { getPlatform } from 'platform';
import { UNIQUE_FIELD } from './constants.ts';

type WarnLogger = { warn (msg: string): void };
/** The Platform methods the check reads. */
type UniqueRows = {
  hashFor (field: string, value: string): string;
  isUniqueValueHeldByAnother (ownerToken: string, field: string, storedValue: string): Promise<boolean>;
};

/**
 * True when another account holds `email` on the platform, in any case and
 * with or without surrounding spaces: in hashed mode the row key is
 * normalised already; in cleartext mode the row key is the address as
 * written (`User@x`, `USER@x` and `user@x` are three rows), and every one is
 * looked at (`Platform.getUniqueValueOwners`). An absent row, or one
 * `username` holds, answers false; a row of another spelling held by another
 * account answers true even when `username` holds its own spelling. Throws
 * when the platform store cannot be read.
 */
export async function isEmailHeldByAnother (platform: UniqueRows, username: string, email: string, index: EmailRowsIndex | null = null): Promise<boolean> {
  const own = platform.hashFor('username', username);
  const stored = platform.hashFor(UNIQUE_FIELD, email);
  // Same answer from the rows read once for many accounts (`Platform.getUniqueValueIndex`).
  if (index != null) return index.rows(stored).some((row) => row.username !== own);
  return await platform.isUniqueValueHeldByAnother(own, UNIQUE_FIELD, stored);
}

/** The email rows read once (`Platform.getUniqueValueIndex('email')`; null in hashed mode). */
export type EmailRowsIndex = { rows (storedValue: string): Array<{ value: string, username: string }> };

/**
 * True when another account holds the account's stored `email`: the caller
 * does not send `what`, and a warning names the account (never the address).
 * Throws when the platform store cannot be read: callers do not send then
 * either.
 */
export async function isStoredEmailHeldElsewhere (username: string, email: unknown, what: string, logger: WarnLogger): Promise<boolean> {
  if (typeof email !== 'string' || email === '') return false;
  if (!await isEmailHeldByAnother(await getPlatform(), username, email)) return false;
  logger.warn(`${what} of user "${username}" not sent: its email is held by another account (the account's email must be changed)`);
  return true;
}
