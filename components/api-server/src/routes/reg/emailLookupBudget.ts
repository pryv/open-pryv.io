/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { Request, Response, NextFunction } from 'express';
import { factory as errors } from 'errors';
import { createAddressBudget } from './addressBudget.ts';
import { clientIp } from 'middleware/src/clientIp.ts';

/**
 * One per-address budget shared by the public email lookups:
 * `GET /reg/{email}/check_email`, `GET /reg/{email}/username`,
 * `GET /reg/{email}/uid`, `GET /reg/cores?email=`, and the registration email
 * challenge (`POST /reg/email-challenge`, which refuses a taken address).
 *
 * They take no credentials and say whether an address belongs to an account
 * (the username routes also say which one), so without a budget a caller could
 * test addresses at request rate. Every lookup counts, found or not, in one
 * counter per address bucket whatever the route: spreading the probes over
 * the four routes buys nothing. Past LOOKUPS_PER_WINDOW in a window opened by
 * the first lookup, the address is refused with 429 until the window ends (see
 * addressBudget.ts for the counting). Every request counts, valid or not. The
 * budget is sized for people signing in by email behind one shared address,
 * not for scripts. Tests that call these routes more than a few times a
 * minute from one address must `clear()` it.
 */

const LOOKUPS_PER_WINDOW = 30;
const WINDOW_MS = 60 * 1000;

const emailLookupBudget = createAddressBudget({ namespace: 'email-lookup-ip/', perWindow: LOOKUPS_PER_WINDOW, windowMs: WINDOW_MS });

/**
 * Count one lookup from `ip`: null when it may run, else the 429 to answer.
 * An empty `ip` (no address known) is not counted.
 */
async function reserveEmailLookup (ip: string | null | undefined): Promise<Error | null> {
  const retryAfterSeconds = await emailLookupBudget.reserve(ip);
  if (retryAfterSeconds == null) return null;
  return errors.tooManyAttempts(retryAfterSeconds, {
    message: `Too many email lookups from this address; retry in ${retryAfterSeconds} s.`,
    data: { retryAfterSeconds }
  });
}

/**
 * Express middleware: counts one lookup from the client's address, refuses it
 * with 429 past the budget. `appliesTo` limits it to the requests that look
 * an email up (`/reg/cores` also answers by username). The methods behind
 * these routes refuse the generic dispatchers (batch, socket.io), so this is
 * the only way in.
 */
function countEmailLookup (appliesTo: (req: Request) => boolean = () => true) {
  return async function (req: Request, _res: Response, next: NextFunction) {
    try {
      if (!appliesTo(req)) return next();
      next(await reserveEmailLookup(clientIp(req)) ?? undefined);
    } catch (err) { next(err); }
  };
}

/**
 * The same question asked by a signed-in account: `account.update` refuses an
 * address another account holds. Counted per account, every address asked
 * about, held or not (several in one call count each).
 */
const ACCOUNT_LOOKUPS_PER_WINDOW = 30;
const ACCOUNT_WINDOW_MS = 60 * 60 * 1000;

const accountEmailLookupBudget = createAddressBudget({
  namespace: 'email-lookup-account/',
  perWindow: ACCOUNT_LOOKUPS_PER_WINDOW,
  windowMs: ACCOUNT_WINDOW_MS,
  keyIsAddress: false
});

/** Count `addresses` addresses `userId` asks about: null when it may, else the 429 to answer. */
async function reserveAccountEmailLookups (userId: string, addresses: number): Promise<Error | null> {
  for (let i = 0; i < addresses; i++) {
    const retryAfterSeconds = await accountEmailLookupBudget.reserve(userId);
    if (retryAfterSeconds != null) {
      return errors.tooManyAttempts(retryAfterSeconds, {
        message: `Too many email addresses were tried on this account; retry in ${retryAfterSeconds} s.`,
        data: { reason: 'account-email-lookups', retryAfterSeconds }
      });
    }
  }
  return null;
}

/** Drop the counters written by this process (tests). */
async function clear (): Promise<void> {
  await emailLookupBudget.clear();
  await accountEmailLookupBudget.clear();
}

export {
  countEmailLookup,
  reserveEmailLookup,
  reserveAccountEmailLookups,
  clear,
  LOOKUPS_PER_WINDOW,
  WINDOW_MS,
  ACCOUNT_LOOKUPS_PER_WINDOW
};
