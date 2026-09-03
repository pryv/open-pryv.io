/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { MethodNext as Next, ResultBag } from './_types.ts';
import type { MethodContext as BaseMethodContext } from 'business/src/MethodContext.ts';

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
  isActive (): boolean;
};
type StoredMfa = { content?: Record<string, unknown>; recoveryCodes?: string[]; method?: string; totp?: TotpState };

type UserRef = { id: string; username: string };
type ThrottleState = { count: number; windowStartedAt: number; lockedUntil?: number };
type AttemptsCfg = {
  perSession: number;
  perAccount: number;
  perAccountWindowSeconds: number;
  lockoutSeconds: number;
};
type Cb<T = unknown> = (err: Error | null, result?: T) => void;
const errors = require('errors').factory;
const commonFns = require('./helpers/commonFunctions.ts');
const methodsSchema = require('../schema/mfaMethods.ts').default;
const { getStorageLayer } = require('storage');
const crypto = require('node:crypto');
const { ready, getLogger } = require('@pryv/boiler');
const mfaLogger = getLogger('methods:mfa');
const { normalizeMfaConfig, getMFAMethod, getMFAMethodForProfile, getMFASessionStore, Profile } = require('business/src/mfa/index.ts');
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
  // Per-account attempt throttle.
  //
  // The per-session ceiling alone is not a limit: a caller holding the
  // password can re-authenticate and get a fresh budget, so the second factor
  // stays brute-forceable. The counter below therefore accrues on the USER,
  // across logins.
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

  /**
   * Compare a supplied recovery code against every stored one without
   * short-circuiting: each candidate is compared in constant time, and the
   * loop always runs to the end, so neither the time to answer nor the
   * position of a match is observable.
   */
  function matchesARecoveryCode (storedCodes: string[], supplied: unknown): boolean {
    const suppliedBuf = Buffer.from(String(supplied ?? ''), 'utf8');
    let matched = false;
    for (const stored of storedCodes) {
      const storedBuf = Buffer.from(stored, 'utf8');
      // timingSafeEqual requires equal lengths; an unequal length is already
      // a mismatch, and the codes are fixed-length so this leaks nothing.
      if (storedBuf.length === suppliedBuf.length && crypto.timingSafeEqual(storedBuf, suppliedBuf)) {
        matched = true;
      }
    }
    return matched;
  }

  async function readThrottle (user: UserRef): Promise<ThrottleState | null> {
    const profileSet = await fromCallback((cb: Cb<{ data?: { mfaThrottle?: ThrottleState } } | null>) =>
      userProfileStorage.findOne(user, { id: PROFILE_ID }, null, cb)) as { data?: { mfaThrottle?: ThrottleState } } | null;
    return profileSet?.data?.mfaThrottle || null;
  }

  /**
   * Persist (or clear, when `state == null`) the throttle. Uses the same
   * one-level dot-notation contract as `saveMFAProfile`: `{ data: { mfaThrottle: X } }`
   * sets the key, `null` unsets it, and neither touches `data.mfa`.
   */
  async function writeThrottle (user: UserRef, state: ThrottleState | null) {
    const existing = await fromCallback((cb: Cb<unknown>) =>
      userProfileStorage.findOne(user, { id: PROFILE_ID }, null, cb));
    if (!existing) {
      if (state == null) return; // nothing stored, nothing to clear
      await fromCallback((cb: Cb<unknown>) =>
        userProfileStorage.insertOne(user, { id: PROFILE_ID, data: { mfaThrottle: state } }, cb));
      return;
    }
    await fromCallback((cb: Cb<unknown>) =>
      userProfileStorage.updateOne(user, { id: PROFILE_ID }, { data: { mfaThrottle: state } }, cb));
  }

  /** Clear the accrual, but only when there is one (avoids a write per login). */
  async function clearThrottleIfAny (user: UserRef) {
    if (await readThrottle(user) == null) return;
    await writeThrottle(user, null);
  }

  /**
   * Refuse the second-factor step while the account is locked. Returns the
   * error to surface, or null to proceed. An expired lock is cleared here.
   *
   * Deliberately returns BEFORE any verify attempt and without writing: a
   * locked caller learns nothing about whether their code was right, and
   * cannot drive storage writes by continuing to guess.
   */
  async function mfaStepLockError (user: UserRef, attemptsCfg: AttemptsCfg): Promise<Error | null> {
    if (attemptsCfg.perAccount === 0) return null;
    const throttle = await readThrottle(user);
    if (!throttle?.lockedUntil) return null;
    const remainingMs = throttle.lockedUntil - Date.now();
    if (remainingMs > 0) return errors.tooManyAttempts(Math.ceil(remainingMs / 1000));
    await writeThrottle(user, null); // lock expired
    return null;
  }

  /**
   * Attempt limiter (all methods). Records a failed verify/confirm against
   * BOTH ceilings: the pending session (which is invalidated at its ceiling,
   * forcing a re-login) and the account (which locks the MFA step for a while
   * once too many failures accrue within the window). Returns the error to
   * surface.
   */
  async function limitOrPassThrough (mfaToken: unknown, user: UserRef, attemptsCfg: AttemptsCfg, verifyErr: Error): Promise<Error> {
    const accountErr = await recordAccountFailure(user, attemptsCfg);
    const attempts = await sessionStore().recordFailedAttempt(mfaToken);
    if (attempts >= attemptsCfg.perSession) {
      await sessionStore().clear(mfaToken);
      // The account lock outranks the session one: it is the condition a
      // re-login would NOT clear, so it is what the caller needs to be told.
      return accountErr || errors.invalidAccessToken('Too many failed MFA attempts; the MFA session has been invalidated. Please log in again.');
    }
    return accountErr || verifyErr;
  }

  /**
   * Accrue one failed second factor against the account. Returns the throttle
   * error when this failure trips the ceiling, else null.
   */
  async function recordAccountFailure (user: UserRef, attemptsCfg: AttemptsCfg): Promise<Error | null> {
    if (attemptsCfg.perAccount === 0) return null; // per-account limiter disabled
    const now = Date.now();
    const windowMs = attemptsCfg.perAccountWindowSeconds * 1000;
    const previous = await readThrottle(user);
    const withinWindow = previous != null && now <= previous.windowStartedAt + windowMs;
    const state: ThrottleState = withinWindow
      ? { count: previous.count + 1, windowStartedAt: previous.windowStartedAt }
      : { count: 1, windowStartedAt: now };

    if (state.count >= attemptsCfg.perAccount) {
      state.lockedUntil = now + attemptsCfg.lockoutSeconds * 1000;
      await writeThrottle(user, state);
      // Logged on the breach transition only, never per failed guess: under an
      // attack the per-guess line would itself be the amplification.
      mfaLogger.warn(
        `MFA per-account attempt limit reached for user "${user.username}"; the second-factor step is locked for ${attemptsCfg.lockoutSeconds}s.`
      );
      return errors.tooManyAttempts(attemptsCfg.lockoutSeconds);
    }
    await writeThrottle(user, state);
    return null;
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
        const lockErr = await mfaStepLockError(user, cfg.attempts);
        if (lockErr) return next(lockErr);
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
        // Re-sending a challenge verifies no code, so it never accrues; but a
        // locked account must not be usable to spam challenge deliveries.
        const lockErr = await mfaStepLockError(user, cfg.attempts);
        if (lockErr) return next(lockErr);
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
        const lockErr = await mfaStepLockError(user, cfg.attempts);
        if (lockErr) return next(lockErr);
        // TOTP replay guard must consult the AUTHORITATIVE stored enrolment, not
        // the login-time session snapshot (F1). The enrolment must still exist
        // AND be the same secret this session authenticated against: if it was
        // deactivated / recovered / rotated since login, this session's factor is
        // stale, so we reject rather than resurrect the old enrolment.
        let storedForTotp: MFAProfile | null = null;
        if (session.profile.method === 'totp' && session.profile.totp) {
          const stored = await loadMFAProfile(user);
          if (!stored.totp || stored.totp.secret !== session.profile.totp.secret) {
            return next(errors.invalidAccessToken('MFA enrolment changed since login; please log in again.'));
          }
          storedForTotp = stored;
          session.profile.totp.lastUsedStep = Math.max(stored.totp.lastUsedStep ?? -1, session.profile.totp.lastUsedStep ?? -1);
        }
        try {
          await method.verify(user.username, session.profile, { headers: {}, body: params });
        } catch (verifyErr) {
          return next(await limitOrPassThrough(params.mfaToken, user, cfg.attempts, verifyErr as Error));
        }
        // Persist ONLY the advanced replay step onto the freshly-loaded stored
        // enrolment (never rewrite the whole data.mfa blob from the login-time
        // snapshot), BEFORE releasing the token so a storage failure fails closed.
        // NB: a same-instant concurrent double-verify TOCTOU remains; closing it
        // needs a storage-level compare-and-set (tracked follow-up).
        if (storedForTotp && storedForTotp.totp) {
          storedForTotp.totp.lastUsedStep = session.profile.totp.lastUsedStep;
          await saveMFAProfile(user, storedForTotp);
        }
        // A real second factor succeeded: drop any accrued failures so an
        // earlier mistyped code cannot count toward a future lock.
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
        if (!matchesARecoveryCode(profile.recoveryCodes, params.recoveryCode)) {
          return next(errors.invalidParametersFormat('Invalid recovery code.'));
        }
        await saveMFAProfile(user, null);
        // Recovery must also lift any lock, else the lock would outlive the
        // enrolment it was guarding.
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
