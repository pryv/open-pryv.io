/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { MethodNext as Next, ResultBag } from './_types.ts';
import type { MethodContext as BaseMethodContext } from 'business/src/MethodContext.ts';
import type { AttemptsCfg } from 'business/src/mfa/index.ts';

const require = createRequire(import.meta.url);
const { fromCallback } = require('utils');

type MethodContext = BaseMethodContext & {
  [key: string]: unknown;
};
type TotpState = {
  secret: string;
  algorithm: string;
  digits: number;
  periodSeconds: number;
  confirmedAt: number | null;
  lastUsedStep: number;
};
type MFAProfile = {
  content: Record<string, unknown>;
  recoveryCodes: string[];
  method?: string;
  totp?: TotpState;
  generateRecoveryCodes (): void;
  getRecoveryCodes (): string[];
  matchesRecoveryCode (supplied: unknown): boolean;
  isActive (): boolean;
};
type StoredMfa = { content?: Record<string, unknown>; recoveryCodes?: string[]; method?: string; totp?: TotpState };

type UserRef = { id: string; username: string };
/** Per-user failure tally. Times in ms; `notBefore` is 0 when no delay applies. */
type ThrottleState = { failures: number; lastFailureAt: number; notBefore: number };
/** What may be stored: the current shape, or the former lockout shape
 *  (`{ count, windowStartedAt, lockedUntil }`) on an upgraded deployment. */
type StoredThrottle = Partial<ThrottleState> & { count?: number; windowStartedAt?: number; lockedUntil?: number };
type Cb<T = unknown> = (err: Error | null, result?: T) => void;
const errors = require('errors').factory;
const commonFns = require('./helpers/commonFunctions.ts');
const methodsSchema = require('../schema/mfaMethods.ts').default;
const { getStorageLayer } = require('storage');
const { ready, getLogger } = require('@pryv/boiler');
const mfaLogger = getLogger('methods:mfa');
const { normalizeMfaConfig, delayForFailures, getMFAMethod, getMFAMethodForProfile, getMFASessionStore, Profile } = require('business/src/mfa/index.ts');
const { getUsersRepository } = require('business/src/users/index.ts');

const PROFILE_ID = 'private';

export default async function (api: { register: (...args: unknown[]) => void }) {
  const storageLayer = await getStorageLayer();
  const userProfileStorage = storageLayer.profile;
  const config = await ready();

  // Read + normalize the MFA config block per-invocation so
  // `config.injectTestConfig()` in tests is honored.
  function getMfaConfig () {
    return normalizeMfaConfig(config.get('services:mfa'));
  }

  /** True when MFA is enabled server-wide (any method active). */
  function mfaEnabled () {
    return getMfaConfig().active === true;
  }
  function sessionStore () {
    return getMFASessionStore(getMfaConfig());
  }
  function requireMFAEnabled (next: Next) {
    if (!mfaEnabled()) {
      next(errors.apiUnavailable('MFA is not enabled on this server.'));
      return false;
    }
    return true;
  }

  // --------------------------------------------------------------------
  // Per-account attempt backoff.
  //
  // The per-session ceiling alone is not a limit: a caller holding the
  // password can re-authenticate and get a fresh budget, so the second factor
  // stays brute-forceable. The tally below therefore accrues on the USER,
  // across logins. Past `backoff.freeFailures` failures each further one
  // imposes a delay before the next attempt (doubling, capped). It is a delay,
  // never a lockout: a caller holding the password must not be able to lock
  // the real user out of their second factor, so the real user waits at most
  // `backoff.maxSeconds`, and a success clears the tally.
  //
  // It lives at `data.mfaThrottle`, a SIBLING of `data.mfa`, not inside it.
  // Two reasons: the profile store only expands one level of dot-notation
  // (a deeper path is not portable across storage engines), and keeping it
  // outside the enrolment blob means a routine enrolment write cannot reset
  // an attacker's accrued count as a side effect. Every clear is explicit.
  //
  // The counter is per-core, and that is complete rather than a compromise: a
  // user is pinned to one home core, so every login and every verify for that
  // user lands here and this profile sees all of their failed attempts. No
  // cross-core state is needed, and none is introduced.
  // --------------------------------------------------------------------

  /** The private profile item, or null when the user has none yet. */
  async function readPrivateProfile (user: UserRef): Promise<{ data?: { mfa?: StoredMfa; mfaThrottle?: StoredThrottle } } | null> {
    return await fromCallback((cb: Cb<unknown>) =>
      userProfileStorage.findOne(user, { id: PROFILE_ID }, null, cb)) as { data?: { mfa?: StoredMfa; mfaThrottle?: StoredThrottle } } | null;
  }

  /**
   * Read a stored tally as the current shape. The former lockout shape reads as
   * a tally, and its `lockedUntil` is deliberately NOT honoured: that lockout
   * is what the backoff replaces.
   */
  function asThrottleState (stored: StoredThrottle | null | undefined): ThrottleState | null {
    if (stored == null || typeof stored !== 'object') return null;
    if (typeof stored.failures === 'number') {
      return { failures: stored.failures, lastFailureAt: stored.lastFailureAt ?? 0, notBefore: stored.notBefore ?? 0 };
    }
    if (typeof stored.count === 'number') {
      return { failures: stored.count, lastFailureAt: stored.windowStartedAt ?? 0, notBefore: 0 };
    }
    return null;
  }

  /** A tally whose last failure is older than the window counts as none. */
  function liveThrottle (state: ThrottleState | null, now: number, attemptsCfg: AttemptsCfg): ThrottleState | null {
    if (state == null) return null;
    if (now - state.lastFailureAt > attemptsCfg.perAccountWindowSeconds * 1000) return null;
    return state;
  }

  /** Clear the tally, but only when there is one (avoids a write per login). */
  async function clearThrottleIfAny (user: UserRef) {
    const item = await readPrivateProfile(user);
    if (item?.data?.mfaThrottle == null) return;
    await fromCallback((cb: Cb<unknown>) =>
      userProfileStorage.updateOne(user, { id: PROFILE_ID }, { data: { mfaThrottle: null } }, cb));
  }

  /**
   * Refuse the second-factor step while a backoff delay runs. Returns the error
   * to surface, or null to proceed.
   *
   * Deliberately returns BEFORE any verify attempt and without writing: a code
   * sent during the delay is neither checked nor counted, so the caller learns
   * nothing from it and cannot drive storage writes by continuing to guess.
   */
  async function mfaBackoffError (user: UserRef, attemptsCfg: AttemptsCfg): Promise<Error | null> {
    if (attemptsCfg.backoff.maxSeconds === 0) return null;
    const now = Date.now();
    const state = liveThrottle(asThrottleState((await readPrivateProfile(user))?.data?.mfaThrottle), now, attemptsCfg);
    if (state == null || state.notBefore <= now) return null;
    const retryAfterSeconds = Math.ceil((state.notBefore - now) / 1000);
    return errors.tooManyAttempts(retryAfterSeconds, {
      message: `Too many failed MFA attempts for this account; retry in ${retryAfterSeconds} s.`,
      data: { retryAfterSeconds }
    });
  }

  /**
   * Attempt limiter (all methods). Records a failed verify/confirm against
   * BOTH ceilings: the pending session (invalidated at its ceiling, forcing a
   * re-login) and the account tally (which delays the NEXT attempt once past
   * the free failures). Returns the error to surface for THIS attempt.
   */
  async function limitOrPassThrough (mfaToken: unknown, user: UserRef, attemptsCfg: AttemptsCfg, verifyErr: Error): Promise<Error> {
    await recordAccountFailure(user, attemptsCfg);
    const attempts = await sessionStore().recordFailedAttempt(mfaToken);
    if (attempts >= attemptsCfg.perSession) {
      await sessionStore().clear(mfaToken);
      return errors.invalidAccessToken('Too many failed MFA attempts; the MFA session has been invalidated. Please log in again.');
    }
    return verifyErr;
  }

  /**
   * Accrue one failed second factor against the account, atomically across
   * API workers: each accrual is a compare-and-set on the stored tally, so N
   * concurrent wrong guesses count N. A race is only ever lost to another
   * accrual that succeeded, so every retry is progress; the bound only caps a
   * pathological burst, where giving up still leaves a tally at least as high
   * as all but the lost ones.
   */
  async function recordAccountFailure (user: UserRef, attemptsCfg: AttemptsCfg): Promise<void> {
    if (attemptsCfg.backoff.maxSeconds === 0) return; // per-account backoff disabled
    const T = ['data', 'mfaThrottle'];
    for (let tries = 0; tries < 10; tries++) {
      const now = Date.now();
      const item = await readPrivateProfile(user);
      const stored = item?.data?.mfaThrottle;
      const previous = liveThrottle(asThrottleState(stored), now, attemptsCfg);
      const failures = (previous?.failures ?? 0) + 1;
      const delaySeconds = delayForFailures(failures, attemptsCfg.backoff);
      const next: ThrottleState = { failures, lastFailureAt: now, notBefore: delaySeconds > 0 ? now + delaySeconds * 1000 : 0 };

      if (item == null) {
        // No private profile yet: create it. A concurrent creator wins the
        // primary key; loop and accrue on top of its row.
        try {
          await fromCallback((cb: Cb<unknown>) =>
            userProfileStorage.insertOne(user, { id: PROFILE_ID, data: { mfaThrottle: next } }, cb));
        } catch (err) {
          if ((err as { isDuplicate?: boolean }).isDuplicate) continue;
          throw err;
        }
      } else {
        // Guard on exactly what was read: nothing, or the same stored count.
        let guard;
        if (stored == null) guard = { path: T, absent: true };
        else if (typeof stored.failures === 'number') guard = { path: [...T, 'failures'], eq: stored.failures };
        else if (typeof stored.count === 'number') guard = { path: [...T, 'count'], eq: stored.count };
        else guard = { path: [...T, 'lastFailureAt'], absent: true }; // unreadable leftover: replace it once
        const written = await fromCallback((cb: Cb<boolean>) =>
          userProfileStorage.compareAndSetJson(user, { id: PROFILE_ID }, [guard], [{ path: T, value: next }], cb));
        if (!written) continue;
      }
      // Logged when a delay first reaches the cap, never per failed guess:
      // under an attack the per-guess line would itself be the amplification.
      if (delaySeconds === attemptsCfg.backoff.maxSeconds && delayForFailures(failures - 1, attemptsCfg.backoff) < delaySeconds) {
        mfaLogger.warn(
          `MFA failures for user "${user.username}" reached the maximum backoff: ${delaySeconds}s between second-factor attempts until one succeeds or the window lapses.`
        );
      }
      return;
    }
  }

  /**
   * Load the MFA profile from `profile.private.data.mfa`. Returns a fresh
   * empty Profile when nothing is stored yet.
   */
  async function loadMFAProfile (user: UserRef): Promise<MFAProfile> {
    const profileSet = await fromCallback((cb: Cb<{ data?: { mfa?: StoredMfa } } | null>) =>
      userProfileStorage.findOne(user, { id: PROFILE_ID }, null, cb)) as { data?: { mfa?: StoredMfa } } | null;
    if (!profileSet || !profileSet.data || !profileSet.data.mfa) return new Profile();
    const stored = profileSet.data.mfa;
    return new Profile(stored.content || {}, stored.recoveryCodes || [], stored.method, stored.totp);
  }

  /**
   * Persist the MFA profile (or clear it when `profile == null`). The user's
   * private profile doc is created if missing.
   *
   * The profile storage converter uses a dot-notation shape: passing
   * `{ data: { mfa: X } }` becomes `$set['data.mfa'] = X`, and passing
   * `{ data: { mfa: null } }` becomes `$unset['data.mfa']`.
   */
  async function saveMFAProfile (user: UserRef, profile: MFAProfile | null) {
    const existing = await fromCallback((cb: Cb<unknown>) =>
      userProfileStorage.findOne(user, { id: PROFILE_ID }, null, cb));
    const mfaValue = profile == null
      ? null // null → $unset['data.mfa']
      : {
          content: profile.content,
          recoveryCodes: profile.recoveryCodes,
          ...(profile.method !== undefined ? { method: profile.method } : {}),
          ...(profile.totp !== undefined ? { totp: profile.totp } : {})
        };
    if (!existing) {
      // If the private profile doesn't exist yet, create it with the mfa block
      // (or skip when clearing — there's nothing to clear).
      if (profile == null) return;
      await fromCallback((cb: Cb<unknown>) =>
        userProfileStorage.insertOne(user, { id: PROFILE_ID, data: { mfa: mfaValue } }, cb));
      return;
    }
    await fromCallback((cb: Cb<unknown>) =>
      userProfileStorage.updateOne(user, { id: PROFILE_ID }, { data: { mfa: mfaValue } }, cb));
  }

  // ----------------------------------------------------------------------
  // mfa.activate
  // ----------------------------------------------------------------------
  api.register('mfa.activate',
    requirePersonalAccess,
    async function activate (context: MethodContext, params: Record<string, unknown>, result: ResultBag, next: Next) {
      if (!requireMFAEnabled(next)) return;
      try {
        // Pick the method: explicit `method` in the body, else the operator's
        // configured default. The method's enroll() populates the (empty)
        // profile with its pending state (SMS: content=body; TOTP: secret) and
        // returns any extra reply fields (TOTP: otpauthUri, secret).
        const cfg = getMfaConfig();
        const methodName = (params.method as string) || cfg.defaultMethod;
        const method = getMFAMethod(methodName, cfg);
        if (method == null) {
          return next(errors.invalidParametersFormat(
            `Unknown or inactive MFA method: ${methodName}`, { id: 'invalid-mfa-method' }));
        }
        const profile = new Profile();
        const extra = await method.enroll(context.user.username, profile, params);
        const token = await sessionStore().create(profile, { user: context.user, kind: 'enroll' });
        result.mfaToken = token;
        Object.assign(result, extra);
        next();
      } catch (err) {
        next(err);
      }
    }
  );

  // ----------------------------------------------------------------------
  // mfa.confirm — receives mfaToken from params (route extracts it from header/body)
  // ----------------------------------------------------------------------
  api.register('mfa.confirm',
    commonFns.getParamsValidation(methodsSchema.confirm.params),
    async function confirm (context: MethodContext, params: Record<string, unknown>, result: ResultBag, next: Next) {
      if (!requireMFAEnabled(next)) return;
      try {
        const session = await sessionStore().get(params.mfaToken);
        if (!session) return next(errors.invalidAccessToken('Invalid or expired MFA session token.'));
        // An enrolment session only (F4): a login token must not regenerate
        // recovery codes / re-persist a profile via confirm.
        if (session.context.kind && session.context.kind !== 'enroll') {
          return next(errors.invalidAccessToken('This MFA token is not valid for enrolment confirmation.'));
        }
        const user = session.context.user;
        const profile = session.profile;
        const cfg = getMfaConfig();
        const method = getMFAMethodForProfile(profile, cfg);
        if (method == null) return next(errors.apiUnavailable('MFA method not available.'));
        const backoffErr = await mfaBackoffError(user, cfg.attempts);
        if (backoffErr) return next(backoffErr);
        try {
          await method.verify(user.username, profile, { headers: {}, body: params });
        } catch (verifyErr) {
          return next(await limitOrPassThrough(params.mfaToken, user, cfg.attempts, verifyErr as Error));
        }
        // TOTP: mark the enrolment confirmed. saveMFAProfile atomically replaces
        // any previous enrolment (whole data.mfa is overwritten).
        if (profile.method === 'totp' && profile.totp) profile.totp.confirmedAt = Date.now();
        profile.generateRecoveryCodes();
        await saveMFAProfile(user, profile);
        await clearThrottleIfAny(user);
        await sessionStore().clear(params.mfaToken);
        result.recoveryCodes = profile.getRecoveryCodes();
        next();
      } catch (err) {
        next(err);
      }
    }
  );

  // ----------------------------------------------------------------------
  // mfa.challenge — re-send SMS during a pending login (mfaToken is bound to a verify-pending session)
  // ----------------------------------------------------------------------
  api.register('mfa.challenge',
    commonFns.getParamsValidation(methodsSchema.challenge.params),
    async function challenge (context: MethodContext, params: Record<string, unknown>, result: ResultBag, next: Next) {
      if (!requireMFAEnabled(next)) return;
      try {
        const session = await sessionStore().get(params.mfaToken);
        if (!session) return next(errors.invalidAccessToken('Invalid or expired MFA session token.'));
        const user = session.context.user;
        const cfg = getMfaConfig();
        const method = getMFAMethodForProfile(session.profile, cfg);
        if (method == null) return next(errors.apiUnavailable('MFA method not available.'));
        // Re-sending a challenge verifies no code, so it never accrues; but an
        // account in backoff must not be usable to spam challenge deliveries.
        const backoffErr = await mfaBackoffError(user, cfg.attempts);
        if (backoffErr) return next(backoffErr);
        const extra = await method.challenge(user.username, session.profile, { headers: {}, body: params });
        result.message = 'Please verify the MFA challenge.';
        Object.assign(result, extra); // { method } for totp, so clients render the right prompt
        next();
      } catch (err) {
        next(err);
      }
    }
  );

  // ----------------------------------------------------------------------
  // mfa.verify — finishes a login-with-MFA flow; returns the real Pryv access token
  // ----------------------------------------------------------------------
  api.register('mfa.verify',
    commonFns.getParamsValidation(methodsSchema.verify.params),
    async function verify (context: MethodContext, params: Record<string, unknown>, result: ResultBag, next: Next) {
      if (!requireMFAEnabled(next)) return;
      try {
        const session = await sessionStore().get(params.mfaToken);
        if (!session) return next(errors.invalidAccessToken('Invalid or expired MFA session token.'));
        // A login session only (F4): an enrolment token must not release a token.
        if (session.context.kind && session.context.kind !== 'login') {
          return next(errors.invalidAccessToken('This MFA token is not valid for login verification.'));
        }
        const user = session.context.user;
        // Fail closed before any side effect (F4a): a login session must carry a
        // stashed token, else a code-verify would persist state and then error.
        if (!session.context.token) {
          return next(errors.unexpectedError(new Error('MFA session has no token to release — login flow not wired')));
        }
        const cfg = getMfaConfig();
        const method = getMFAMethodForProfile(session.profile, cfg);
        if (method == null) return next(errors.apiUnavailable('MFA method not available.'));
        const backoffErr = await mfaBackoffError(user, cfg.attempts);
        if (backoffErr) return next(backoffErr);
        // TOTP replay guard must consult the AUTHORITATIVE stored enrolment, not
        // the login-time session snapshot (F1). The enrolment must still exist
        // AND be the same secret this session authenticated against: if it was
        // deactivated / recovered / rotated since login, this session's factor is
        // stale, so we reject rather than resurrect the old enrolment.
        const isTotp = session.profile.method === 'totp' && session.profile.totp != null;
        if (isTotp) {
          const stored = await loadMFAProfile(user);
          if (!stored.totp || stored.totp.secret !== session.profile.totp.secret) {
            return next(errors.invalidAccessToken('MFA enrolment changed since login; please log in again.'));
          }
          if (typeof stored.totp.lastUsedStep !== 'number') {
            mfaLogger.warn(`MFA enrolment of user "${user.username}" has no numeric lastUsedStep; its codes are refused until it is re-enrolled.`);
          }
          session.profile.totp.lastUsedStep = Math.max(stored.totp.lastUsedStep ?? -1, session.profile.totp.lastUsedStep ?? -1);
        }
        const stepBefore = isTotp ? session.profile.totp.lastUsedStep : null;
        try {
          await method.verify(user.username, session.profile, { headers: {}, body: params });
        } catch (verifyErr) {
          return next(await limitOrPassThrough(params.mfaToken, user, cfg.attempts, verifyErr as Error));
        }
        // Consume the accepted step with ONE conditional write, BEFORE releasing
        // the token (a storage failure fails closed): it succeeds only if the
        // enrolment is still this session's secret AND the stored step is still
        // below the accepted one. That is atomic across API workers, so of two
        // concurrent verifies of the same code exactly one wins, and a smaller
        // step arriving after a larger one was consumed is refused.
        if (isTotp) {
          const acceptedStep = session.profile.totp.lastUsedStep;
          const consumed = acceptedStep > stepBefore && await fromCallback((cb: Cb<boolean>) =>
            userProfileStorage.compareAndSetJson(user, { id: PROFILE_ID },
              [{ path: ['data', 'mfa', 'totp', 'secret'], eq: session.profile.totp.secret },
                { path: ['data', 'mfa', 'totp', 'lastUsedStep'], lt: acceptedStep }],
              [{ path: ['data', 'mfa', 'totp', 'lastUsedStep'], value: acceptedStep }], cb));
          if (!consumed) {
            // Lost the race for this step, a drift-window regression, or the
            // enrolment rotated after the check above: this code is no longer
            // acceptable, which is a failed attempt, not a success.
            return next(await limitOrPassThrough(params.mfaToken, user, cfg.attempts,
              errors.invalidParametersFormat('The provided MFA code is invalid.', { id: 'invalid-mfa-code' })));
          }
        }
        // A real second factor succeeded: drop any accrued failures so an
        // earlier mistyped code cannot count toward a future delay.
        await clearThrottleIfAny(user);
        // session.context.token is the real access token stashed by the login flow
        // (presence already checked above, before any side effect).
        result.token = session.context.token;
        if (session.context.apiEndpoint) result.apiEndpoint = session.context.apiEndpoint;
        await sessionStore().clear(params.mfaToken);
        next();
      } catch (err) {
        next(err);
      }
    }
  );

  // ----------------------------------------------------------------------
  // mfa.deactivate — personal token; clears the user's MFA profile
  // ----------------------------------------------------------------------
  api.register('mfa.deactivate',
    requirePersonalAccess,
    commonFns.getParamsValidation(methodsSchema.deactivate.params),
    async function deactivate (context: MethodContext, params: Record<string, unknown>, result: ResultBag, next: Next) {
      try {
        await saveMFAProfile(context.user as UserRef, null);
        await clearThrottleIfAny(context.user as UserRef);
        result.message = 'MFA deactivated.';
        next();
      } catch (err) {
        next(err);
      }
    }
  );

  // ----------------------------------------------------------------------
  // mfa.recover — no auth; validates user/password/recoveryCode then clears MFA
  //
  // Deliberately NOT subject to the per-account attempt limiter, in either of
  // its steps. This is the last-resort path, so a limiter here would be a net
  // loss:
  //   - the recovery codes are 122-bit random values, so guessing them is not
  //     a realistic threat and a ceiling buys no security;
  //   - the password check is the same one auth.login performs unthrottled, so
  //     throttling it here removes no capability from an attacker (they would
  //     simply use login) while handing anyone, with no credentials at all, a
  //     way to lock a known user out of their own recovery by submitting wrong
  //     passwords.
  // It therefore never reads or writes the throttle on failure and never
  // returns too-many-attempts. A SUCCESSFUL recovery does clear the throttle,
  // below, since the enrolment it guarded is being removed.
  // ----------------------------------------------------------------------
  api.register('mfa.recover',
    commonFns.getParamsValidation(methodsSchema.recover.params),
    async function recover (context: MethodContext, params: Record<string, unknown>, result: ResultBag, next: Next) {
      try {
        const usersRepository = await getUsersRepository();
        const user = await usersRepository.getUserByUsername(params.username);
        if (!user) return next(errors.invalidCredentials());
        const isValid = await usersRepository.checkUserPassword(user.id, params.password);
        if (!isValid) return next(errors.invalidCredentials());
        const profile = await loadMFAProfile(user);
        if (!profile.isActive()) {
          return next(errors.invalidOperation('MFA is not active for this user.'));
        }
        if (!profile.matchesRecoveryCode(params.recoveryCode)) {
          return next(errors.invalidParametersFormat('Invalid recovery code.'));
        }
        await saveMFAProfile(user, null);
        // Recovery also clears the failure tally, else a backoff would outlive
        // the enrolment it was guarding.
        await clearThrottleIfAny(user);
        result.message = 'MFA deactivated.';
        next();
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * Step that requires the call to be made with a personal access token.
   * Uses the same shape as other auth-bound steps in service-core.
   */
  function requirePersonalAccess (context: MethodContext, params: Record<string, unknown>, result: ResultBag, next: Next) {
    if (!context.access || context.access.type !== 'personal') {
      return next(errors.forbidden('A personal access token is required for this operation.'));
    }
    next();
  }
};
