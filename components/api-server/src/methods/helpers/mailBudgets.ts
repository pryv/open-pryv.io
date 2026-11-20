/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Budgets on mail a caller can make the platform send to addresses of its
 * choice, besides the per-address ones:
 *
 * - registration codes per client address (`account.emailVerification.
 *   registrationCodesPerIpPerHour`): the per-address code budget alone lets
 *   one caller mail every address of a list;
 * - distinct addresses one account gets verification mails sent to per day
 *   (`account.emailVerification.addressesPerAccountPerDay`): `maxEmails` caps
 *   the addresses held at once, not an add / remove cycle through new ones;
 * - mails per hour from this core on the caller-triggered paths
 *   (`services.email.maxPerHour`, counted per class: registration codes +
 *   welcome, and verification + password reset): a circuit breaker for sender
 *   reputation and provider cost, logged once per window and worker when it
 *   trips. Notices the platform sends on its own (deletion reminders, MFA
 *   changes, ...) are not counted nor stopped.
 *
 * Counters live in cluster_kv (per core, shared by its API workers). 0 turns
 * a budget off. A store that cannot answer lets the mail go.
 */

import { getConfigUnsafe, getLogger } from '@pryv/boiler';
import { factory as errors } from 'errors';
import { createAddressBudget, markIfAbsent, unmark, clearMarkers } from '../../routes/reg/addressBudget.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const MAIL_BUDGET_DEFAULTS = Object.freeze({
  registrationCodesPerIpPerHour: 10,
  addressesPerAccountPerDay: 10,
  maxPerHour: 500
});

const logger = getLogger('mail-budgets');

function countOr (value: unknown, fallback: number): number {
  return (typeof value === 'number' && Number.isInteger(value) && value >= 0) ? value : fallback;
}

function configured (key: string, fallback: number): () => number {
  // Read at each count (after boot), so a changed value applies at once.
  return () => countOr(getConfigUnsafe().get(key), fallback);
}

const challengeIpBudget = createAddressBudget({
  namespace: 'email-challenge-ip/',
  perWindow: configured('account:emailVerification:registrationCodesPerIpPerHour', MAIL_BUDGET_DEFAULTS.registrationCodesPerIpPerHour),
  windowMs: HOUR_MS
});

const ADDRESS_MARKER_NS = 'email-verify-address-day/';
const addressesPerAccountPerDay = configured('account:emailVerification:addressesPerAccountPerDay', MAIL_BUDGET_DEFAULTS.addressesPerAccountPerDay);
const accountAddressBudget = createAddressBudget({
  namespace: 'email-verify-addresses/',
  perWindow: addressesPerAccountPerDay,
  windowMs: DAY_MS,
  keyIsAddress: false
});

// One breaker per class, each `services.email.maxPerHour`: a flood of
// unauthenticated registration codes cannot stop password resets.
type MailClass = 'registration' | 'account';
const coreMailBreaker = createAddressBudget({
  namespace: 'mail-breaker/',
  perWindow: configured('services:email:maxPerHour', MAIL_BUDGET_DEFAULTS.maxPerHour),
  windowMs: HOUR_MS,
  keyIsAddress: false
});
const breakerWarnedUntil: Record<MailClass, number> = { registration: 0, account: 0 };

/** Counts one registration code for client address `ip`: null, or the 429 to answer. */
async function reserveChallengeFromIp (ip: string | null | undefined): Promise<Error | null> {
  const retryAfterSeconds = await challengeIpBudget.reserve(ip);
  if (retryAfterSeconds == null) return null;
  return errors.tooManyAttempts(retryAfterSeconds, {
    message: `Too many verification codes were requested from this address; retry in ${retryAfterSeconds} s.`,
    data: { reason: 'ip-limit', retryAfterSeconds }
  });
}

/**
 * Counts `email` among the addresses `userId` got a verification mail for
 * today (an address already counted today is free): null, or the seconds
 * until the account may mail a new address. The address marker lasts 24 h from
 * its first mail and the account's window 24 h from its first count, so over a
 * rolling day an account may reach up to about twice the configured addresses.
 */
async function reserveVerificationAddress (userId: string, email: string): Promise<number | null> {
  if (addressesPerAccountPerDay() <= 0) return null;
  const markerKey = userId + '/' + email.toLowerCase();
  if (!(await markIfAbsent(ADDRESS_MARKER_NS, markerKey, DAY_MS))) return null;
  const retryAfterSeconds = await accountAddressBudget.reserve(userId);
  if (retryAfterSeconds != null) await unmark(ADDRESS_MARKER_NS, markerKey);
  return retryAfterSeconds;
}

/**
 * Counts one caller-triggered mail of `mailClass` from this core: null, or the
 * 429 to answer. `registration`: registration codes and welcome mails;
 * `account`: verification and password-reset mails.
 */
async function meterCallerMail (mailClass: MailClass): Promise<Error | null> {
  const retryAfterSeconds = await coreMailBreaker.reserve(mailClass);
  if (retryAfterSeconds == null) return null;
  if (Date.now() > breakerWarnedUntil[mailClass]) {
    breakerWarnedUntil[mailClass] = Date.now() + retryAfterSeconds * 1000;
    logger.warn(`outbound mail breaker: services.email.maxPerHour reached for ${mailClass} mails on this core (this worker); they are refused for ${retryAfterSeconds} s`);
  }
  return errors.tooManyRequests('The platform is sending too many emails right now. Please retry later.', retryAfterSeconds);
}

/** Drop the counters written by this process (tests). */
async function clear (): Promise<void> {
  await challengeIpBudget.clear();
  await accountAddressBudget.clear();
  await coreMailBreaker.clear();
  await clearMarkers();
  breakerWarnedUntil.registration = 0;
  breakerWarnedUntil.account = 0;
}

export { MAIL_BUDGET_DEFAULTS, reserveChallengeFromIp, reserveVerificationAddress, meterCallerMail, clear };
export type { MailClass };
