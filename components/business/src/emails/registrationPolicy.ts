/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Operator policy for the registration email challenge, read from live config.
 *
 * Kept apart from `container.ts` (whose getters are about container events and
 * the account verification link) because this policy governs a flow that runs
 * before any account exists.
 */

import { getConfig } from '@pryv/boiler';
import * as C from './constants.ts';

/** Whether creating an account requires proving the email address first. */
export async function isRegistrationVerificationRequired (): Promise<boolean> {
  const config = await getConfig();
  return config.get('account:emailVerification:requireAtRegistration') === true;
}

/** How long a mailed code stays valid (ms). */
export async function getRegistrationCodeMaxAgeMs (): Promise<number> {
  return await positiveNumber(
    'account:emailVerification:registrationCodeMaxAgeMs',
    C.DEFAULT_REGISTRATION_CODE_MAX_AGE_MS
  );
}

/** Wrong tries allowed against one code before it is discarded. */
export async function getRegistrationCodeMaxAttempts (): Promise<number> {
  const raw = await positiveNumber(
    'account:emailVerification:registrationCodeMaxAttempts',
    C.DEFAULT_REGISTRATION_CODE_MAX_ATTEMPTS
  );
  // A code with no attempt budget is unusable; an unbounded one is a brute
  // force oracle. Clamp rather than trust the operator's arithmetic.
  return Math.max(1, Math.min(Math.floor(raw), 20));
}

/** Minimum delay between two codes for the same address (ms). 0 disables it. */
export async function getRegistrationCodeResendCooldownMs (): Promise<number> {
  const config = await getConfig();
  const raw = config.get('account:emailVerification:registrationCodeResendCooldownMs');
  return typeof raw === 'number' && raw >= 0
    ? raw
    : C.DEFAULT_REGISTRATION_CODE_RESEND_COOLDOWN_MS;
}

/** Codes that may be mailed to one address per day. */
export async function getRegistrationCodeDailyLimit (): Promise<number> {
  const raw = await positiveNumber(
    'account:emailVerification:registrationCodeDailyLimit',
    C.DEFAULT_REGISTRATION_CODE_DAILY_LIMIT
  );
  return Math.max(1, Math.floor(raw));
}

/** Wrong tries allowed against one address per day, across codes. */
export async function getRegistrationCodeFailuresPerDay (): Promise<number> {
  const raw = await positiveNumber(
    'account:emailVerification:registrationCodeFailuresPerDay',
    C.DEFAULT_REGISTRATION_CODE_FAILURES_PER_DAY
  );
  return Math.max(1, Math.floor(raw));
}

/** How long a successful verification's proof stays usable for registering (ms). */
export async function getRegistrationProofMaxAgeMs (): Promise<number> {
  return await positiveNumber(
    'account:emailVerification:registrationProofMaxAgeMs',
    C.DEFAULT_REGISTRATION_PROOF_MAX_AGE_MS
  );
}

async function positiveNumber (key: string, fallback: number): Promise<number> {
  const config = await getConfig();
  const raw = config.get(key);
  return typeof raw === 'number' && raw > 0 ? raw : fallback;
}
