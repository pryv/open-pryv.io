/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { ConfigLike } from '@pryv/boiler';
import { factory as errors } from 'errors';
import { getUsersRepository } from 'business/src/users/index.ts';
import { normalizePasswordAttempts } from 'business/src/auth/passwordAttempts.ts';
import { passwordIpRefusal, countPasswordIpFailure } from 'business/src/auth/passwordIpThrottle.ts';
import { createAccountAttemptThrottle } from './accountAttemptThrottle.ts';

/**
 * The account password asked again for a sensitive change (a step-up). It
 * counts like a sign-in: on the account's password tally (the
 * `passwordThrottle` field sign-in and `account.changePassword` use) and on
 * the caller's address budget, so a stolen token does not make it a password
 * oracle.
 */

type UserRef = { id: string; username: string };
type ProfileStorage = Parameters<typeof createAccountAttemptThrottle>[0]['profileStorage'];

export function createPasswordStepUp (opts: {
  config: ConfigLike;
  profileStorage: ProfileStorage;
  logger: { warn (msg: string): void };
  /** The answer to a password that does not match (default: invalid-step-up). */
  mismatchError?: () => Error;
}) {
  const mismatchError = opts.mismatchError ?? (() => errors.invalidStepUp('The given password does not match; nothing was changed.'));
  const tally = createAccountAttemptThrottle({
    profileStorage: opts.profileStorage,
    field: 'passwordThrottle',
    label: 'password',
    attemptNoun: 'password',
    logger: opts.logger
  });

  /** Null when `password` is the account's; else the error to answer. */
  return async function checkPassword (user: UserRef, password: string, ip: string | null | undefined): Promise<Error | null> {
    const attempts = normalizePasswordAttempts(opts.config.get('auth:passwordAttempts'));
    const ipErr = await passwordIpRefusal(ip, attempts.perIp);
    if (ipErr) return ipErr;
    const attemptErr = await tally.reserve(user, attempts);
    if (attemptErr) return attemptErr;
    if (!await (await getUsersRepository()).checkUserPassword(user.id, password)) {
      await countPasswordIpFailure(ip, attempts.perIp);
      return mismatchError();
    }
    await tally.clearIfAny(user);
    return null;
  };
}
