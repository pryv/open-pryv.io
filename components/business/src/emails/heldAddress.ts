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
 * Shared by the senders to the stored email: the password reset, the MFA
 * change notice and the auto-deletion notices.
 */

import { isRowFreeFor } from './container.ts';

type WarnLogger = { warn (msg: string): void };

/**
 * True when another account holds `email` on the platform: the caller does
 * not send `what`, and a warning names the account (never the address). An
 * absent row, or one this account holds, answers false. Throws when the
 * platform store cannot be read: callers do not send then either.
 */
export async function isStoredEmailHeldElsewhere (username: string, email: unknown, what: string, logger: WarnLogger): Promise<boolean> {
  if (typeof email !== 'string' || email === '') return false;
  if (await isRowFreeFor(username, email)) return false;
  logger.warn(`${what} of user "${username}" not sent: its email is held by another account (the account's email must be changed)`);
  return true;
}
