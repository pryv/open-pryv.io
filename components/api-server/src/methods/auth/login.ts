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
const { normalizeMfaConfig, getMFAMethodForProfile, getMFASessionStore, Profile: MFAProfile } = require('business/src/mfa/index.ts');
// Breach-scope reverse-index: personal accesses are created here at login (a
// distinct site from accesses.create), so index them too. Non-fatal.
const { reindexAccessNonFatal } = require('platform/src/accessIndex.ts');

const MFA_PROFILE_ID = 'private';

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
    context.sessionData = {
      username: context.user.username,
      appId: params.appId
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
          // never a session reused/shared through getMatching). See B-2026-09-17-5.
          context.sessionGenerated = true;
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
                result.token = access.token;
                accessData.token = access.token;
                updatePersonalAccess(accessData, access, context, next);
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
      const rotating = accessData.token !== previousToken && previousToken != null;
      // When two logins for the same (user, appId) race with a stale token on
      // the row (the previous session already expired), both mint a fresh
      // session and would each overwrite the token, leaving the loser with a
      // live session whose token is on no access (403 on first use,
      // B-2026-09-17-5). Guard the rotation with a compare-and-swap on the
      // observed token: only the login whose `previousToken` still matches wins.
      // Otherwise keep the original plain update (token unchanged -> idempotent).
      const query = rotating ? { ...(context.accessQuery as Record<string, unknown>), token: previousToken } : context.accessQuery;
      userAccessesStorage.updateOne(context.user, query, accessData, (err: Error | null, updated?: AccessRow | null) => {
        if (err != null) return callback(err);
        if (rotating && updated == null) {
          // Lost the race: a concurrent login rotated the token first. Adopt the
          // winner's (live) token instead of clobbering it, and drop our own
          // orphan session so no client is ever handed a dead token.
          return findAccess(context, (err2: Error | null, winner: AccessRow | null) => {
            if (err2 != null || winner == null) return callback(err2 ?? errors.unexpectedError(new Error('access vanished during concurrent login')));
            const orphanToken = result.token as string | undefined;
            result.token = winner.token;
            accessData.token = winner.token;
            const finish = () => {
              const merged = { id: winner.id, type: winner.type, created: winner.created, expires: winner.expires, modified: winner.modified };
              reindexAccessNonFatal(context.user.username, merged as { id?: unknown }).then(() => callback(null));
            };
            if (context.sessionGenerated === true && orphanToken != null && orphanToken !== winner.token) {
              sessionsStorage.destroy(orphanToken, () => finish());
            } else {
              finish();
            }
          });
        }
        // Won the rotation, or a plain (no-rotation) update.
        // Keep the reverse-index fresh on token rotation, and index a
        // pre-backfill personal access on its next login. Merge the
        // authoritative identity fields with the just-bumped modified time.
        const merged = { id: existing.id, type: existing.type, created: existing.created, expires: existing.expires, modified: accessData.modified };
        reindexAccessNonFatal(context.user.username, merged as { id?: unknown }).then(() => callback(null));
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
   * MFA integration. Runs as the final step of auth.login.
   *
   * If the user has MFA active (persistent state at `profile.private.data.mfa`)
   * AND the server has MFA enabled (`services.mfa.mode !== 'disabled'`):
   *   1. Call mfaService.challenge() — typically triggers an SMS to the user's phone
   *   2. Stash the already-issued Pryv access token + apiEndpoint + user in a new
   *      SessionStore session, keyed by a fresh mfaToken
   *   3. Delete `token`/`apiEndpoint` from the response and replace with `mfaToken`
   *
   * The caller must then call `mfa.verify` with the mfaToken + SMS code to
   * receive the real Pryv access token. If they fail / never verify, the session
   * expires (default 30 min) and the token is simply never released — matching
   * the original service-mfa proxy behaviour.
   *
   * When MFA is disabled server-wide OR the user has no `profile.mfa`, this step
   * is a no-op and the original login response is returned unchanged.
   */
  async function mfaCheckIfActive (context: MethodContext, params: Record<string, unknown>, result: ResultBag, next: Next) {
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
        // (e.g. an operator enabled the new model without activating `sms`,
        // stranding legacy SMS enrolments). Fail OPEN but never silently: this
        // is a migration hazard the operator must see. See CHANGELOG migration note.
        mfaLogger.warn(
          `MFA-enrolled user "${context.user.username}" logged in WITHOUT a second factor: their method is not active in services.mfa. Check the methods.{sms,totp}.active config.`
        );
        return next();
      }
      await method.challenge(context.user.username, profile, { headers: {}, body: params });

      // Stash the already-issued token in a pending session. Only release on mfa.verify.
      const mfaToken = await getMFASessionStore(mfaCfg).create(profile, {
        user: context.user,
        token: result.token,
        apiEndpoint: result.apiEndpoint,
        kind: 'login'
      });

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
      next(err);
    }
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
