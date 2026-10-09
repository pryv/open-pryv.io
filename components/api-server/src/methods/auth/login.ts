/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { MethodNext as Next, ResultBag } from '../_types.ts';
import type { MethodContext as BaseMethodContext } from 'business/src/MethodContext.ts';

const require = createRequire(import.meta.url);
const { fromCallback } = require('utils');

type MethodContext = BaseMethodContext & {
  [key: string]: unknown;
};
type AccessRow = { token?: string; [k: string]: unknown };
/** What `mfaResolveForLogin` hands over to `mfaCheckIfActive`. */
type MfaLoginState = {
  cfg: Record<string, unknown>;
  profile: unknown;
  method: { name: string; challenge: (username: string, profile: unknown, clientRequest: Record<string, unknown>) => Promise<unknown> };
  /** The pending MFA session, once `mfaOpenLoginSession` opened it. */
  mfaToken?: string;
};
const commonFns = require('api-server/src/methods/helpers/commonFunctions.ts');
const { ApiEndpoint } = require('utils');
const errors = require('errors').factory;
const methodsSchema = require('api-server/src/schema/authMethods.ts');
const { getUsersRepository, UserRepositoryOptions, getPasswordRules } = require('business/src/users/index.ts');
const { getStorageLayer } = require('storage');
const { ready, getLogger } = require('@pryv/boiler');
const mfaLogger = getLogger('methods:auth:mfa');
const { setAuditAccessId, AuditAccessIds } = require('audit/src/MethodContextUtils.ts');
const timestamp = require('unix-timestamp');
const { normalizeMfaConfig, getMFAMethodForProfile, getMFASessionStore, Profile: MFAProfile, enrolmentFingerprint } = require('business/src/mfa/index.ts');
// Breach-scope reverse-index: personal accesses are created here at login (a
// distinct site from accesses.create), so index them too. Non-fatal.
const { reindexAccessNonFatal } = require('platform/src/accessIndex.ts');

const MFA_PROFILE_ID = 'private';

// Refused logins of an enrolled user whose method is not active are logged at
// most once per user per window, per process, so a client retrying in a loop
// cannot flood the log. The map is dropped whole when it grows past its cap.
const INACTIVE_METHOD_WARN_WINDOW_MS = 10 * 60 * 1000;
const INACTIVE_METHOD_WARN_MAX_KEYS = 10000;
const inactiveMethodWarnedAt = new Map<string, number>();
function shouldWarnInactiveMethod (userId: string, now: number = Date.now()): boolean {
  const last = inactiveMethodWarnedAt.get(userId);
  if (last != null && now - last < INACTIVE_METHOD_WARN_WINDOW_MS) return false;
  if (inactiveMethodWarnedAt.size >= INACTIVE_METHOD_WARN_MAX_KEYS) inactiveMethodWarnedAt.clear();
  inactiveMethodWarnedAt.set(userId, now);
  return true;
}

/**
 * Auth API methods implementations.
 *
 */
export default async function (api: { register: (...args: unknown[]) => void }) {
  const usersRepository = await getUsersRepository();
  const storageLayer = await getStorageLayer();
  const userAccessesStorage = storageLayer.accesses;
  const userProfileStorage = storageLayer.profile;
  const sessionsStorage = storageLayer.sessions;
  const config = await ready();
  // Lazy getters instead of slice captures. Every config slice this
  // factory reads is resolved per-request from the live config
  // singleton, matching the long-standing `getMfaConfig` pattern.
  const getAuth = () => config.get('auth');
  const getMfaConfig = () => normalizeMfaConfig(config.get('services:mfa'));
  const passwordRules = await getPasswordRules();

  api.register('auth.login',
    commonFns.getParamsValidation(methodsSchema.login.params),
    commonFns.getTrustedAppCheck(getAuth),
    applyPrerequisitesForLogin,
    checkPassword,
    mfaResolveForLogin,
    mfaOpenLoginSession,
    openSession,
    updateOrCreatePersonalAccess,
    addApiEndpoint,
    setAuditAccessId(AuditAccessIds.VALID_PASSWORD),
    setAdditionalInfo,
    mfaCheckIfActive);

  // Third-party sign-in mint. It is the auth.login chain minus the params-schema,
  // the trusted-app/origin check (the caller is the server itself, identity
  // already proven by the IdP), and the PASSWORD check (there is no password in
  // an SSO login). Everything else is the SAME functions, so the minted session,
  // personal access, apiEndpoint and the MFA gate are byte-identical to a
  // password login; auth.login above is untouched.
  //
  // Because it mints WITHOUT a password, it must run ONLY on the server-internal,
  // token-less context the SSO callback (routes/sso.ts) builds after the IdP has
  // proven the identity and the linking rules resolved a username. It is NOT
  // "unreachable": the generic dispatchers (callBatch, socket.io) set methodId
  // from client input, so any authenticated caller could otherwise reach it. The
  // `refuseIfAuthenticated` first step is the deliberate gate that confines it to
  // the credential-less internal context (an external call always carries an
  // access/token), so a token-holder can never drive a no-password personal-access
  // mint through it.
  api.register('auth.ssoLogin',
    refuseIfAuthenticated,
    applyPrerequisitesForLogin,
    mfaResolveForLogin,
    mfaOpenLoginSession,
    openSession,
    updateOrCreatePersonalAccess,
    addApiEndpoint,
    setAuditAccessId(AuditAccessIds.VALID_SSO),
    setAdditionalInfo,
    mfaCheckIfActive);

  // Confine auth.ssoLogin to the server-internal mint context: that context is
  // built token-less (no access, no accessToken), whereas ANY externally
  // dispatched call (HTTP batch, socket.io) arrives with a loaded access. Reject
  // the latter before any side effect (session mint / personal-access create).
  function refuseIfAuthenticated (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    if (context.access != null || context.accessToken != null) {
      return next(errors.invalidOperation('auth.ssoLogin is server-internal and cannot be called with an access token.'));
    }
    next();
  }

  function applyPrerequisitesForLogin (context: MethodContext, params: { username: string }, _result: ResultBag, next: Next) {
    const fixedUsername = params.username.toLowerCase();
    if (context.user.username !== fixedUsername) {
      return next(errors.invalidOperation('The username in the path does not match that of ' +
          'the credentials.'));
    }
    next();
  }

  async function checkPassword (context: MethodContext, params: { password: string }, result: ResultBag, next: Next) {
    try {
      const isValid = await usersRepository.checkUserPassword(context.user.id, params.password);
      if (!isValid) {
        return next(errors.invalidCredentials());
      }
      const expirationAndChangeTimes = await passwordRules.getPasswordExpirationAndChangeTimes(context.user.id);
      if (expirationAndChangeTimes.passwordExpires <= timestamp.now()) {
        const formattedExpDate = timestamp.toDate(expirationAndChangeTimes.passwordExpires).toISOString();
        const err = errors.invalidCredentials('Password expired since ' + formattedExpDate);
        err.data = { expiredTime: expirationAndChangeTimes.passwordExpires };
        return next(err);
      }
      Object.assign(result, expirationAndChangeTimes);
      next();
    } catch (err) {
      // handles unexpected errors
      return next(err);
    }
  }

  function openSession (context: MethodContext, params: { appId: string }, result: ResultBag, next: Next) {
    // The user id makes a session match only its own account: a session of a
    // former owner of this username (renamed or deleted) is never reused.
    context.sessionData = {
      username: context.user.username,
      appId: params.appId,
      userId: context.user.id
    };
    sessionsStorage.getMatching(context.sessionData, function (err: Error | null, sessionId: string | null) {
      if (err) { return next(errors.unexpectedError(err)); }
      if (sessionId) {
        result.token = sessionId;
        next();
      } else {
        sessionsStorage.generate(context.sessionData, null, function (err: Error | null, sessionId: string) {
          if (err) { return next(errors.unexpectedError(err)); }
          result.token = sessionId;
          // This login minted a fresh session (no matching one existed). Record
          // it so that if a concurrent same-appId login wins the token rotation
          // below, we may safely destroy this orphan session (it is ours alone,
          // never a session reused/shared through getMatching).
          context.sessionGenerated = true;
          context.generatedSessionToken = sessionId;
          next();
        });
      }
    });
  }

  function updateOrCreatePersonalAccess (context: MethodContext, params: { appId: string }, result: ResultBag, next: Next) {
    context.accessQuery = { name: params.appId, type: 'personal' };
    findAccess(context, (err: Error | null, access: AccessRow | null) => {
      if (err) { return next(errors.unexpectedError(err)); }
      const accessData: AccessRow = { token: result.token as string | undefined };
      if (access != null) {
        // Access is already existing, updating it with new token (as we have updated the sessions with it earlier).
        updatePersonalAccess(accessData, access, context, next);
      } else {
        // Access not found, creating it
        createAccess(accessData, context, (err: (Error & { isDuplicate?: boolean }) | null) => {
          if (err != null) {
            // Concurrency issue, the access is already created
            // by a simultaneous login (happened between a & b), retrieving and updating its modifiedTime, while keeping the same previous token
            if (err.isDuplicate) {
              findAccess(context, (err: Error | null, access: AccessRow | null) => {
                if (err || access == null) { return next(errors.unexpectedError(err)); }
                const orphanToken = result.token as string | undefined;
                result.token = access.token;
                accessData.token = access.token;
                const proceed = () => updatePersonalAccess(accessData, access, context, next);
                // The session this login generated backs no access now: drop it.
                if (context.sessionGenerated === true && orphanToken != null && orphanToken !== access.token) {
                  return sessionsStorage.destroy(orphanToken, () => proceed());
                }
                proceed();
              });
            } else {
              // Any other error
              return next(errors.unexpectedError(err));
            }
          } else {
            next();
          }
        });
      }
    });

    function findAccess (context: MethodContext, callback: (err: Error | null, access: AccessRow | null) => void) {
      userAccessesStorage.findOne(context.user, context.accessQuery, null, callback);
    }

    function createAccess (access: AccessRow, context: MethodContext, callback: (err: (Error & { isDuplicate?: boolean }) | null) => void) {
      Object.assign(access, context.accessQuery);
      context.initTrackingProperties(access, UserRepositoryOptions.SYSTEM_USER_ACCESS_ID);
      userAccessesStorage.insertOne(context.user, access, (err: (Error & { isDuplicate?: boolean }) | null, inserted?: AccessRow | null) => {
        if (err != null) return callback(err);
        // Index the authoritative inserted row (carries the generated id).
        reindexAccessNonFatal(context.user.username, (inserted ?? access) as { id?: unknown }).then(() => callback(null));
      });
    }

    function updatePersonalAccess (accessData: AccessRow, existing: AccessRow, context: MethodContext, callback: (err: Error | null) => void) {
      context.updateTrackingProperties(accessData, UserRepositoryOptions.SYSTEM_USER_ACCESS_ID);
      const previousToken = existing.token;
      // We "minted" a token when openSession generated a fresh session because it
      // found no live one to reuse; the row still carries a different, older token.
      const minted = accessData.token !== previousToken && previousToken != null;

      // Refresh the reverse-index for an identity row, then finish.
      const finishWith = (idRow: AccessRow) => {
        const merged = { id: idRow.id, type: idRow.type, created: idRow.created, expires: idRow.expires, modified: idRow.modified };
        reindexAccessNonFatal(context.user.username, merged as { id?: unknown }).then(() => callback(null));
      };
      // Return `winnerToken` (which is already on the row and backed by a live
      // session) to the client instead of our minted one, and drop our own orphan
      // session. Deliberately does NOT write the row: an unconditional write could
      // clobber a token another login rotated in between (reintroducing the bug),
      // and the winning login already wrote its token + tracking.
      const adopt = (winnerToken: string | undefined, idRow: AccessRow) => {
        const orphanToken = result.token as string | undefined;
        result.token = winnerToken;
        accessData.token = winnerToken;
        const done = () => finishWith(idRow);
        if (context.sessionGenerated === true && orphanToken != null && orphanToken !== winnerToken) {
          sessionsStorage.destroy(orphanToken, () => done());
        } else {
          done();
        }
      };

      if (!minted) {
        // Token unchanged (session reused, or the create-duplicate path already
        // adopted the winner's token): plain idempotent update, as before.
        return userAccessesStorage.updateOne(context.user, context.accessQuery, accessData, (err: Error | null) => {
          if (err != null) return callback(err);
          finishWith(existing);
        });
      }

      // We minted a fresh token but the row still carries an older one. If that
      // token still has a LIVE session, a concurrent login is using it (it just
      // wrote the row and returned that token to its client): ADOPT it rather than
      // rotate it away, which would strand that login (403 on first use).
      // Only rotate when the previous session is truly dead.
      sessionsStorage.get(previousToken as string, (err: Error | null, session?: unknown) => {
        if (err != null) return callback(errors.unexpectedError(err));
        if (session != null) return adopt(previousToken, existing);

        // Previous session dead: rotate with a compare-and-swap on the observed
        // token so two logins racing the same stale token converge on one winner.
        const casQuery = { ...(context.accessQuery as Record<string, unknown>), token: previousToken };
        userAccessesStorage.updateOne(context.user, casQuery, accessData, (err2: Error | null, updated?: AccessRow | null) => {
          if (err2 != null) return callback(err2);
          if (updated != null) return finishWith(existing); // won the rotation
          // Lost: another login rotated first. Adopt the winner's live token.
          findAccess(context, (err3: Error | null, winner: AccessRow | null) => {
            if (err3 != null || winner == null) return callback(err3 ?? errors.unexpectedError(new Error('access vanished during concurrent login')));
            adopt(winner.token, winner);
          });
        });
      });
    }
  }

  function addApiEndpoint (context: MethodContext, _params: unknown, result: ResultBag, next: Next) {
    if (result.token) {
      result.apiEndpoint = ApiEndpoint.build(context.user.username, result.token);
    }
    next();
  }

  async function setAdditionalInfo (context: MethodContext, _params: unknown, result: ResultBag, next: Next) {
    // get user details
    const usersRepository = await getUsersRepository();
    const userBusiness = await usersRepository.getUserByUsername(context.user.username);
    if (!userBusiness) return next(errors.unknownResource('user', context.user.username));
    result.preferredLanguage = userBusiness.language;
    next();
  }

  /**
   * MFA resolution. Runs once the identity is proven (password checked, or the
   * SSO identity resolved) and BEFORE any session or personal access is
   * written, so a refused login leaves nothing behind.
   *
   * If the server has MFA enabled AND the user has an active enrolment
   * (persistent state at `profile.private.data.mfa`), the enrolment's method is
   * resolved and kept on the context for `mfaCheckIfActive`. When that method
   * is not active on this server, the login is refused (403
   * mfa-method-inactive), unless `services.mfa.allowLoginWhenMethodInactive` is
   * true, which lets it proceed with the password only and logs a warning.
   *
   * When MFA is disabled server-wide OR the user has no active enrolment, this
   * step is a no-op.
   */
  async function mfaResolveForLogin (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    const mfaCfg = getMfaConfig();
    if (mfaCfg.active !== true) return next(); // MFA disabled server-wide
    try {
      const profileSet = await fromCallback((cb: (err?: unknown, res?: unknown) => void) =>
        userProfileStorage.findOne(context.user, { id: MFA_PROFILE_ID }, null, cb)) as { data?: { mfa?: { content?: Record<string, unknown>; recoveryCodes?: string[]; method?: string; totp?: unknown } } } | null;
      const storedMfa = profileSet && profileSet.data && profileSet.data.mfa;
      if (!storedMfa) return next(); // no MFA state for this user
      const profile = new MFAProfile(storedMfa.content || {}, storedMfa.recoveryCodes || [], storedMfa.method, storedMfa.totp);
      // Method-aware active check: TOTP requires a confirmed enrolment; SMS
      // requires non-empty content. A pending (unconfirmed) TOTP secret is not
      // active, so login stands as-is.
      if (!profile.isActive()) return next();
      const method = getMFAMethodForProfile(profile, mfaCfg);
      if (method == null) {
        // The user has confirmed MFA but its method is not active server-side
        // (e.g. the legacy `mode` was removed without activating `sms`).
        const methodName = profile.method || 'sms';
        if (mfaCfg.allowLoginWhenMethodInactive === true) {
          mfaLogger.warn(
            `MFA-enrolled user "${context.user.username}" logged in WITHOUT a second factor: their method (${methodName}) is not active in services.mfa and services.mfa.allowLoginWhenMethodInactive is true.`
          );
          return next();
        }
        if (shouldWarnInactiveMethod(String(context.user.id ?? context.user.username))) {
          mfaLogger.warn(
            `Login refused for MFA-enrolled user "${context.user.username}": their method (${methodName}) is not active in services.mfa. Activate services.mfa.methods.${methodName}, or see services.mfa.allowLoginWhenMethodInactive. (Logged at most once per user every ${INACTIVE_METHOD_WARN_WINDOW_MS / 60000} minutes.)`
          );
        }
        return next(errors.mfaMethodInactive(methodName));
      }
      context.mfaLogin = { cfg: mfaCfg, profile, method };
      next();
    } catch (err) {
      next(err);
    }
  }

  /**
   * Opens the pending MFA session of the login and sends its challenge (an
   * SMS for the SMS method; nothing to send for TOTP), when
   * `mfaResolveForLogin` found an active enrolment with an active method.
   *
   * Runs BEFORE any session or personal access is written, so a login refused
   * here (the cap on pending MFA sessions, the SMS send limits, a failing SMS
   * provider) leaves no session behind and rotates no app token. The session
   * receives the token to release once that token exists (`mfaCheckIfActive`);
   * until then its mfaToken is known to this login only.
   */
  async function mfaOpenLoginSession (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    const pending = context.mfaLogin as MfaLoginState | undefined;
    if (pending == null) return next();
    const { cfg: mfaCfg, profile, method } = pending;
    try {
      const store = getMFASessionStore(mfaCfg);
      const mfaToken = await store.create(profile, {
        user: context.user,
        kind: 'login',
        // The enrolment this session is opened against: mfa.challenge and
        // mfa.verify refuse the session once the stored one differs.
        enrolment: enrolmentFingerprint(profile)
      });
      // None of the login parameters is passed: the password never reaches
      // the MFA method layer. A failed challenge leaves no pending session.
      try {
        await method.challenge(context.user.username, profile, { headers: {}, body: {}, sessionId: mfaToken });
      } catch (err) {
        await store.clear(mfaToken);
        throw err;
      }
      pending.mfaToken = mfaToken;
      next();
    } catch (err) {
      next(err);
    }
  }

  /**
   * MFA integration. Runs as the final step of auth.login.
   *
   * When `mfaOpenLoginSession` opened a pending MFA session:
   *   1. Stash the issued Pryv access token + apiEndpoint in that session
   *   2. Delete `token`/`apiEndpoint` from the response and replace with `mfaToken`
   *
   * The caller must then call `mfa.verify` with the mfaToken + code to
   * receive the real Pryv access token. If they fail / never verify, the session
   * expires (default 30 min) and the token is simply never released, matching
   * the original service-mfa proxy behaviour.
   *
   * Otherwise this step is a no-op and the original login response is
   * returned unchanged.
   */
  async function mfaCheckIfActive (context: MethodContext, _params: Record<string, unknown>, result: ResultBag, next: Next) {
    const pending = context.mfaLogin as MfaLoginState | undefined;
    if (pending?.mfaToken == null) return next();
    const { cfg: mfaCfg, method, mfaToken } = pending;
    try {
      // Only mfa.verify releases the stashed token. A session that ended in
      // between (it outlived its lifetime) releases nothing: fail closed.
      const stashed = await getMFASessionStore(mfaCfg).addToContext(mfaToken, {
        token: result.token,
        apiEndpoint: result.apiEndpoint
      });
      if (!stashed) throw errors.unexpectedError(new Error('The MFA session of this login ended before the login completed.'));

      // Replace the response: caller must complete MFA before they see the real token.
      delete result.token;
      delete result.apiEndpoint;
      delete result.preferredLanguage;
      delete result.passwordExpires;
      delete result.passwordCanBeChanged;
      result.mfaToken = mfaToken;
      result.mfaMethod = method.name;
      next();
    } catch (err) {
      // The token is never released: end the session this login opened for
      // it, so no usable session outlives the refused login, and give the
      // MFA session's place back.
      await endUnreleasedLogin(context, result, mfaCfg, mfaToken);
      next(err);
    }
  }

  /**
   * Cleanup of a login refused after its session was written. The session is
   * ended only when this login generated it and still holds its token (a
   * session reused through getMatching, or a concurrent login's token adopted
   * in its place, belongs to another login). The personal access then carries
   * a token without a session, which authenticates nothing; the next login of
   * the app rotates it. Best-effort: a failure here is logged, never surfaced
   * in place of the refusal.
   */
  async function endUnreleasedLogin (context: MethodContext, result: ResultBag, mfaCfg: Record<string, unknown>, mfaToken: string) {
    const token = result.token;
    if (typeof token === 'string' && token === context.generatedSessionToken) {
      try {
        await new Promise<void>((resolve, reject) => sessionsStorage.destroy(token, (err: Error | null) => err != null ? reject(err) : resolve()));
      } catch (err) {
        mfaLogger.error(`Refused login of "${context.user.username}": its session could not be ended: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      await getMFASessionStore(mfaCfg).clear(mfaToken);
    } catch (_err) { /* the MFA session expires on its own */ }
  }

  // LOGOUT

  api.register('auth.logout',
    commonFns.getParamsValidation(methodsSchema.logout.params),
    destroySession);

  function destroySession (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    sessionsStorage.destroy(context.accessToken, function (err: Error | null) {
      next(err ? errors.unexpectedError(err) : null);
    });
  }
};
