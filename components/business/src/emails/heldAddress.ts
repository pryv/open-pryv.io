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
import { PiiHasher } from 'platform/src/PiiHasher.ts';
import { UNIQUE_FIELD } from './constants.ts';

type WarnLogger = { warn (msg: string): void };
/** The Platform methods the check reads. */
type UniqueRows = {
  readonly piiModeIsHashed?: boolean;
  hashFor (field: string, value: string): string;
  getUsersUniqueField (field: string, value: string): Promise<string | null>;
};

/**
 * The spellings of `email` under which a row may hold it. In hashed mode the
 * row key is normalised (trimmed, lowercased) already: one lookup. In
 * cleartext mode the row key is the address as written, so `User@x` and
 * `user@x` are two rows: the stored spelling and its normalised forms.
 */
export function emailSpellings (email: string, hashed: boolean): string[] {
  if (hashed) return [email];
  return [...new Set([email, PiiHasher.normalize(UNIQUE_FIELD, email), email.toLowerCase()])];
}

/**
 * True when another account holds `email` on the platform, under any of its
 * spellings (see `emailSpellings`). An absent row, or one `username` holds,
 * answers false. Throws when the platform store cannot be read.
 */
export async function isEmailHeldByAnother (platform: UniqueRows, username: string, email: string): Promise<boolean> {
  const own = platform.hashFor('username', username);
  for (const spelling of emailSpellings(email, platform.piiModeIsHashed === true)) {
    const owner = await platform.getUsersUniqueField(UNIQUE_FIELD, spelling);
    if (owner != null && owner !== own) return true;
  }
  return false;
}

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
