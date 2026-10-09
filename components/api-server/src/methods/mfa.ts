/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { MethodNext as Next, ResultBag } from './_types.ts';
import type { MethodContext as BaseMethodContext } from 'business/src/MethodContext.ts';
import type { AttemptsCfg, NormalizedMfaConfig } from 'business/src/mfa/index.ts';
import type { MfaChange } from './helpers/mfaChange.ts';

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
/** Per-user failure tally, counted when an attempt is reserved. Times in ms;
 *  `lastFailureAt` is the last reserved attempt; `notBefore` is 0 when no delay applies. */
type ThrottleState = { failures: number; lastFailureAt: number; notBefore: number };
/** What may be stored: the current shape, or the former lockout shape
 *  (`{ count, windowStartedAt, lockedUntil }`) on an upgraded deployment. */
type StoredThrottle = Partial<ThrottleState> & { count?: number; windowStartedAt?: number; lockedUntil?: number };
type Cb<T = unknown> = (err: Error | null, result?: T) => void;
const errors = require('errors').factory;
const APIError = require('errors').APIError;
const delegation = require('delegation');
const commonFns = require('./helpers/commonFunctions.ts');
const { notifyMfaChange: notifyMfaChangeFor, auditMfaChange } = require('./helpers/mfaChange.ts');
const methodsSchema = require('../schema/mfaMethods.ts').default;
const { getStorageLayer } = require('storage');
const { ready, getLogger } = require('@pryv/boiler');
const mfaLogger = getLogger('methods:mfa');
const { normalizeMfaConfig, normalizeAttempts, delayForFailures, getMFAMethod, getMFAMethodForProfile, getMFASessionStore, Profile, enrolmentFingerprint } = require('business/src/mfa/index.ts');
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
  // imposes a delay before the next attempt (doubling, capped). Every attempt
  // is counted BEFORE its code is checked (and the count cleared on success),
  // so attempts sent in parallel cannot all pass the check. It is a delay,
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

  /** A tally whose last attempt is older than the window counts as none. */
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
    return backoffErrorFor(state.notBefore, now);
  }

  function backoffErrorFor (notBefore: number, now: number): Error {
    const retryAfterSeconds = Math.ceil((notBefore - now) / 1000);
    return errors.tooManyAttempts(retryAfterSeconds, {
      message: `Too many failed MFA attempts for this account; retry in ${retryAfterSeconds} s.`,
      data: { retryAfterSeconds }
    });
  }

  function sessionCeilingError (): Error {
    return errors.invalidAccessToken('Too many failed MFA attempts; the MFA session has been invalidated. Please log in again.');
  }

  /** At least one attempt per session, whatever the configured ceiling. */
  function perSessionCeiling (attemptsCfg: AttemptsCfg): number {
    return Math.max(attemptsCfg.perSession, 1);
  }

  /**
   * Attempt limiter (all methods), run BEFORE the code is checked. Takes one
   * slot on the pending session, then one on the account tally, each with a
   * compare-and-set, so N attempts in flight at once take N slots and none
   * past a ceiling reaches the method. The session goes first so the account
   * tally only counts attempts that are then evaluated.
   *
   * Returns `{ attempts }` (the session slot taken) or the error to surface.
   */
  async function reserveAttempt (mfaToken: unknown, user: UserRef, attemptsCfg: AttemptsCfg): Promise<{ attempts: number } | { error: Error }> {
    // Read-only first: during a delay, refuse without spending a session slot.
    const backoffErr = await mfaBackoffError(user, attemptsCfg);
    if (backoffErr) return { error: backoffErr };
    const slot = await sessionStore().reserveAttempt(mfaToken, perSessionCeiling(attemptsCfg));
    if ('refused' in slot) {
      if (slot.refused === 'gone') return { error: errors.invalidAccessToken('Invalid or expired MFA session token.') };
      if (slot.refused === 'ceiling') {
        await sessionStore().clear(mfaToken);
        return { error: sessionCeilingError() };
      }
      return { error: busyError() };
    }
    const accountErr = await reserveAccountAttempt(user, attemptsCfg);
    if (accountErr) {
      // The code is not checked: give the session slot back.
      await sessionStore().releaseAttempt(mfaToken);
      return { error: accountErr };
    }
    return { attempts: slot.attempts };
  }

  /**
   * After a failed verify/confirm, whose slots were already taken: invalidate
   * the session once it has used its last slot. Returns the error to surface.
   */
  async function afterFailedAttempt (mfaToken: unknown, attempts: number, attemptsCfg: AttemptsCfg, verifyErr: Error): Promise<Error> {
    if (attempts >= perSessionCeiling(attemptsCfg)) {
      await sessionStore().clear(mfaToken);
      return sessionCeilingError();
    }
    return verifyErr;
  }

  function busyError (): Error {
    return errors.tooManyAttempts(1, {
      message: 'Too many concurrent MFA attempts for this account; retry in 1 s.',
      data: { retryAfterSeconds: 1 }
    });
  }

  /**
   * Count one second-factor attempt against the account before it is checked,
   * atomically across API workers: a compare-and-set on the stored tally, so N
   * attempts in flight take N slots. Refused while the delay set by the
   * PREVIOUS attempt runs, so a burst reaches the method at most
   * `freeFailures + 1` times. A success clears the tally afterwards. A race is
   * only ever lost to another reservation that succeeded; one that keeps
   * losing is refused (fail closed), never let through uncounted.
   */
  async function reserveAccountAttempt (user: UserRef, attemptsCfg: AttemptsCfg): Promise<Error | null> {
    if (attemptsCfg.backoff.maxSeconds === 0) return null; // per-account backoff disabled
    const T = ['data', 'mfaThrottle'];
    for (let tries = 0; tries < 10; tries++) {
      const now = Date.now();
      const item = await readPrivateProfile(user);
      const stored = item?.data?.mfaThrottle;
      const previous = liveThrottle(asThrottleState(stored), now, attemptsCfg);
      if (previous != null && previous.notBefore > now) return backoffErrorFor(previous.notBefore, now);
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
      } else if (stored != null && typeof stored.failures !== 'number' && typeof stored.count !== 'number') {
        // An unreadable leftover offers nothing to guard on: replace it outright.
        await fromCallback((cb: Cb<unknown>) =>
          userProfileStorage.updateOne(user, { id: PROFILE_ID }, { data: { mfaThrottle: next } }, cb));
      } else {
        // Guard on exactly what was read: nothing, or the same stored count.
        const guard = stored == null
          ? { path: T, absent: true as const }
          : typeof stored.failures === 'number'
            ? { path: [...T, 'failures'], eq: stored.failures }
            : { path: [...T, 'count'], eq: stored.count as number };
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
      return null;
    }
    mfaLogger.warn(`MFA attempt for user "${user.username}" refused: lost the race to concurrent attempts 10 times in a row.`);
    return busyError();
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

  /**
   * Consume an accepted TOTP step with ONE conditional write: it succeeds only
   * if the stored enrolment is still `secret` AND its stored step is still
   * below the accepted one. Atomic across API workers, so of two concurrent
   * uses of the same code exactly one wins, and a smaller step arriving after
   * a larger one was consumed is refused. False means the code is no longer
   * acceptable.
   */
  async function consumeTotpStep (user: UserRef, secret: string, acceptedStep: number, stepBefore: number | null | undefined): Promise<boolean> {
    if (typeof stepBefore !== 'number' || !(acceptedStep > stepBefore)) return false;
    return !!await fromCallback((cb: Cb<boolean>) =>
      userProfileStorage.compareAndSetJson(user, { id: PROFILE_ID },
        [{ path: ['data', 'mfa', 'totp', 'secret'], eq: secret },
          { path: ['data', 'mfa', 'totp', 'lastUsedStep'], lt: acceptedStep }],
        [{ path: ['data', 'mfa', 'totp', 'lastUsedStep'], value: acceptedStep }], cb));
  }

  // --------------------------------------------------------------------
  // Step-up. Turning MFA off, or replacing an active enrolment, weakens the
  // account's second factor, so a personal token alone is not enough: the
  // body must also carry the account password or a code of the CURRENT
  // factor. A wrong step-up is a failed attempt on the per-account tally
  // above, so it cannot be used to guess either.
  // --------------------------------------------------------------------

  /** Null when the call may proceed; else the error to surface. */
  async function checkStepUp (user: UserRef, params: Record<string, unknown>, stored: MFAProfile, cfg: NormalizedMfaConfig): Promise<Error | null> {
    const hasCode = params.code != null;
    const hasPassword = params.password != null;
    if (hasCode === hasPassword) {
      return errors.invalidParametersFormat(
        'This operation requires a step-up: send either "password" (the account password) or "code" (a code of the current MFA factor).',
        { id: 'step-up-required' });
    }
    const value = hasCode ? params.code : params.password;
    if (typeof value !== 'string') {
      return errors.invalidParametersFormat(`"${hasCode ? 'code' : 'password'}" must be a string.`, { id: 'step-up-required' });
    }
    // Counted before it is checked; refused unchecked while a delay runs. With
    // MFA off server-wide the normalized config has no `attempts`; the
    // operator's limits still apply to mfa.deactivate then.
    const attemptsCfg: AttemptsCfg = cfg.attempts ?? normalizeAttempts(config.get('services:mfa:attempts'));
    const attemptErr = await reserveAccountAttempt(user, attemptsCfg);
    if (attemptErr) return attemptErr;
    const ok = hasCode
      ? await currentFactorCodeMatches(user, stored, value, cfg)
      : await (await getUsersRepository()).checkUserPassword(user.id, value);
    if (!ok) return errors.invalidStepUp();
    await clearThrottleIfAny(user);
    return null;
  }

  /**
   * A code of the stored, active enrolment, consumed so it cannot be used
   * again (for a step-up or a login). TOTP only: an SMS code exists only
   * after a challenge, and none is sent for a step-up, so an SMS enrolment
   * steps up with the password.
   */
  async function currentFactorCodeMatches (user: UserRef, stored: MFAProfile, code: string, cfg: NormalizedMfaConfig): Promise<boolean> {
    if (!stored.isActive() || stored.method !== 'totp' || stored.totp == null) return false;
    const method = getMFAMethodForProfile(stored, cfg);
    if (method == null) return false;
    const stepBefore = stored.totp.lastUsedStep;
    try {
      await method.verify(user.username, stored, { headers: {}, body: { code } });
    } catch (err) {
      if ((err as { data?: { id?: string } }).data?.id === 'invalid-mfa-code') return false;
      throw err;
    }
    return await consumeTotpStep(user, stored.totp.secret, stored.totp.lastUsedStep, stepBefore);
  }

  // E-mail notice of an MFA change, to the account's address (best-effort,
  // off the response path; see helpers/mfaChange.ts).
  function notifyMfaChange (user: UserRef, change: MfaChange): void {
    notifyMfaChangeFor(config, user, change);
  }

  /**
   * The pending MFA session must belong to the account of the request path
   * (`/:username/mfa/...`): a token of one account presented under another's
   * path is refused as an unknown token, so it cannot act there, and the
   * call's audit row lands in the right account's trail.
   */
  function sessionOfPathUser (session: { context: { user?: { id?: unknown } } } | undefined, context: MethodContext): boolean {
    const sessionUserId = session?.context?.user?.id;
    return typeof sessionUserId === 'string' && sessionUserId !== '' && sessionUserId === context.user?.id;
  }

  /**
   * A login session is bound to the enrolment it was opened against (its
   * fingerprint is recorded at login): once that enrolment is gone or
   * replaced, the session's factor is stale and the session is refused.
   */
  function loginEnrolmentMatches (session: { context: { enrolment?: unknown } }, stored: MFAProfile): boolean {
    const recorded = session.context.enrolment;
    if (typeof recorded !== 'string' || recorded === '') return false;
    return enrolmentFingerprint(stored) === recorded;
  }

  function enrolmentChangedError (): Error {
    return errors.invalidAccessToken('MFA enrolment changed since login; please log in again.');
  }

  function invalidSessionError (): Error {
    return errors.invalidAccessToken('Invalid or expired MFA session token.');
  }

  // ----------------------------------------------------------------------
  // mfa.activate
  // ----------------------------------------------------------------------
  api.register('mfa.activate',
    requirePersonalAccess,
    commonFns.getParamsValidation(methodsSchema.activate.params),
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
        // The step-up fields are never enrolment content (SMS content is
        // `phone` plus the operator's allow-listed keys, templated into the
        // provider request). Checked before the step-up, so a malformed
        // request spends no attempt and no code.
        const enrolParams = { ...params };
        delete enrolParams.code;
        delete enrolParams.password;
        method.checkEnrolParams(enrolParams);
        // Replacing an active enrolment needs a step-up; a first enrolment
        // does not (there is no factor to protect yet).
        const user = context.user as UserRef;
        const stored = await loadMFAProfile(user);
        if (stored.isActive()) {
          const stepUpErr = await checkStepUp(user, params, stored, cfg);
          if (stepUpErr) return next(stepUpErr);
        }
        const profile = new Profile();
        const extra = await method.enroll(context.user.username, profile, enrolParams);
        // `replaces` pins the enrolment this activation was allowed to
        // replace (null: none), checked again when it is confirmed.
        const store = sessionStore();
        const token = await store.create(profile, { user: context.user, kind: 'enroll', replaces: enrolmentFingerprint(stored) });
        // One pending enrolment per user: this one invalidates any earlier
        // one, whatever its method. The slot is claimed before anything is
        // sent, so an activation that loses it to concurrent ones (429) sends
        // nothing; the earlier enrolment is cleared only once the challenge
        // went out, so a refused activation leaves it usable.
        const userKey = String(user.id);
        const previous = await store.claimEnrolSlot(userKey, token);
        // The first challenge of the enrolment (an SMS for the SMS method),
        // sent for this session. Nothing of the activate body is passed.
        let challengeExtra: Record<string, unknown>;
        try {
          challengeExtra = await method.challenge(context.user.username, profile, { headers: {}, body: {}, sessionId: token });
        } catch (err) {
          await store.giveBackEnrolSlot(userKey, token, previous);
          await store.clear(token);
          throw err;
        }
        if (previous != null) await store.clear(previous);
        result.mfaToken = token;
        Object.assign(result, challengeExtra, extra);
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
        if (!session || !sessionOfPathUser(session, context)) return next(invalidSessionError());
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
        // The enrolment this confirmation replaces must be the one the
        // activation was allowed to replace: one enrolled meanwhile (by
        // another session) was never stepped up for.
        const replaced = enrolmentFingerprint(await loadMFAProfile(user));
        if (replaced != null && replaced !== session.context.replaces) {
          await sessionStore().clear(params.mfaToken);
          return next(errors.invalidOperation('The MFA enrolment of this account changed since this activation started; start again with mfa.activate.'));
        }
        const slot = await reserveAttempt(params.mfaToken, user, cfg.attempts);
        if ('error' in slot) return next(slot.error);
        try {
          // Only the code is handed over: nothing else of the body reaches a provider.
          await method.verify(user.username, profile, { headers: {}, body: { code: params.code }, sessionId: params.mfaToken });
        } catch (verifyErr) {
          return next(await afterFailedAttempt(params.mfaToken, slot.attempts, cfg.attempts, verifyErr as Error));
        }
        // TOTP: mark the enrolment confirmed. saveMFAProfile atomically replaces
        // any previous enrolment (whole data.mfa is overwritten).
        if (profile.method === 'totp' && profile.totp) profile.totp.confirmedAt = Date.now();
        profile.generateRecoveryCodes();
        await saveMFAProfile(user, profile);
        await clearThrottleIfAny(user);
        await sessionStore().clear(params.mfaToken);
        result.recoveryCodes = profile.getRecoveryCodes();
        notifyMfaChange(user, replaced != null ? 'replaced' : 'enrolled');
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
        if (!session || !sessionOfPathUser(session, context)) return next(invalidSessionError());
        const user = session.context.user;
        const cfg = getMfaConfig();
        const method = getMFAMethodForProfile(session.profile, cfg);
        if (method == null) return next(errors.apiUnavailable('MFA method not available.'));
        // A login session challenges the enrolment it was opened against only:
        // once that enrolment is gone or replaced, nothing is sent to it.
        if (session.context.kind === 'login' && !loginEnrolmentMatches(session, await loadMFAProfile(user))) {
          await sessionStore().clear(params.mfaToken);
          return next(enrolmentChangedError());
        }
        // Re-sending a challenge verifies no code, so it never accrues; but an
        // account in backoff must not be usable to spam challenge deliveries.
        const backoffErr = await mfaBackoffError(user, cfg.attempts);
        if (backoffErr) return next(backoffErr);
        // Nothing of the request body is passed: a challenge needs none of it.
        const extra = await method.challenge(user.username, session.profile, { headers: {}, body: {}, sessionId: params.mfaToken });
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
        if (!session || !sessionOfPathUser(session, context)) return next(invalidSessionError());
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
        // Whatever the method, the stored enrolment must still be the one this
        // session was opened against (deactivated, recovered or re-enrolled
        // since: refused, before any attempt is spent).
        const stored = await loadMFAProfile(user);
        if (!loginEnrolmentMatches(session, stored)) {
          await sessionStore().clear(params.mfaToken);
          return next(enrolmentChangedError());
        }
        // TOTP replay guard must consult the AUTHORITATIVE stored enrolment, not
        // the login-time session snapshot (F1). The enrolment must still exist
        // AND be the same secret this session authenticated against: if it was
        // deactivated / recovered / rotated since login, this session's factor is
        // stale, so we reject rather than resurrect the old enrolment.
        const isTotp = session.profile.method === 'totp' && session.profile.totp != null;
        if (isTotp) {
          if (!stored.totp || stored.totp.secret !== session.profile.totp.secret) {
            return next(enrolmentChangedError());
          }
          if (typeof stored.totp.lastUsedStep !== 'number') {
            mfaLogger.warn(`MFA enrolment of user "${user.username}" has no numeric lastUsedStep; its codes are refused until it is re-enrolled.`);
          }
          session.profile.totp.lastUsedStep = Math.max(stored.totp.lastUsedStep ?? -1, session.profile.totp.lastUsedStep ?? -1);
        }
        const stepBefore = isTotp ? session.profile.totp.lastUsedStep : null;
        const slot = await reserveAttempt(params.mfaToken, user, cfg.attempts);
        if ('error' in slot) return next(slot.error);
        try {
          await method.verify(user.username, session.profile, { headers: {}, body: { code: params.code }, sessionId: params.mfaToken });
        } catch (verifyErr) {
          return next(await afterFailedAttempt(params.mfaToken, slot.attempts, cfg.attempts, verifyErr as Error));
        }
        // Consume the accepted step BEFORE releasing the token (a storage
        // failure fails closed), with the conditional write of consumeTotpStep.
        if (isTotp) {
          const consumed = await consumeTotpStep(user, session.profile.totp.secret, session.profile.totp.lastUsedStep, stepBefore);
          if (!consumed) {
            // Lost the race for this step, a drift-window regression, or the
            // enrolment rotated after the check above: this code is no longer
            // acceptable, which is a failed attempt, not a success.
            return next(await afterFailedAttempt(params.mfaToken, slot.attempts, cfg.attempts,
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
  // mfa.deactivate: personal token plus a step-up; clears the user's MFA profile
  // ----------------------------------------------------------------------
  api.register('mfa.deactivate',
    requirePersonalAccess,
    commonFns.getParamsValidation(methodsSchema.deactivate.params),
    async function deactivate (context: MethodContext, params: Record<string, unknown>, result: ResultBag, next: Next) {
      try {
        const user = context.user as UserRef;
        const cfg = getMfaConfig();
        const stored = await loadMFAProfile(user);
        // Required whether or not an enrolment is active, so the contract
        // does not depend on (and does not reveal) the account's MFA state.
        const stepUpErr = await checkStepUp(user, params, stored, cfg);
        if (stepUpErr) return next(stepUpErr);
        await saveMFAProfile(user, null);
        await clearThrottleIfAny(user);
        if (stored.isActive()) notifyMfaChange(user, 'deactivated');
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
        // The account named in the body must be the one of the request path,
        // so the call and its audit rows concern one account.
        const pathUserId = (context.user as Partial<UserRef> | undefined)?.id;
        if (pathUserId != null && pathUserId !== user.id) return next(errors.invalidCredentials());
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
        // The call itself is audited without a user (it holds no access of
        // the account): the account's own trail gets a row of its own.
        await auditMfaChange(config, user.id, 'mfa.recovered', { method: profile.method ?? 'sms' });
        notifyMfaChange(user, 'recovered');
        result.message = 'MFA deactivated.';
        next();
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * Step that requires the call to be made with a personal access token from
   * the account's own login: a delegate's personal access is refused, so a
   * delegate can neither turn the owner's MFA off nor replace it (which would
   * lock the owner out of the direct login that ends a delegation).
   */
  function requirePersonalAccess (context: MethodContext, params: Record<string, unknown>, result: ResultBag, next: Next) {
    if (!context.access || context.access.type !== 'personal') {
      return next(errors.forbidden('A personal access token is required for this operation.'));
    }
    if (!delegation.isGenuineLoginAccess(context.access)) {
      return next(new APIError(
        delegation.errorIds.DelegationErrorIds.GENUINE_LOGIN_REQUIRED,
        'This operation requires a direct login to this account; a delegated session cannot change its MFA',
        { httpStatus: 403 }));
    }
    next();
  }
};
