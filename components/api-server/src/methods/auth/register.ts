/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { MethodContext } from 'business/src/MethodContext.ts';
import type { MethodNext } from '../_types.ts';
import type { Platform } from 'platform/src/Platform.ts';
const require = createRequire(import.meta.url);
const commonFns = require('./../helpers/commonFunctions.ts');
const errors = require('errors').factory;
const methodsSchema = require('api-server/src/schema/authMethods.ts');
const Registration = require('business/src/auth/registration.ts').default;
const { getPlatform } = require('platform');
const { setAuditAccessId, AuditAccessIds } = require('audit/src/MethodContextUtils.ts');
const { ready } = require('@pryv/boiler');
const { getStorageLayer } = require('storage');
const { getPasswordRules, getUsersRepository } = require('business').users;
const challenge = require('business/src/emails/challenge.ts');
const policy = require('business/src/emails/registrationPolicy.ts');
const mailing = require('./../helpers/mailing.ts');

type RegisterParams = { username?: string; password?: string; email?: string; [k: string]: unknown };
type EmailChallengeParams = { email: string; language?: string };
type EmailChallengeVerifyParams = { email: string; code: string };
type CheckUsernameParams = { username: string };
type CheckUniqueParams = Record<string, string>;
type CoresParams = { username?: string; email?: string };
type HostingsParams = Record<string, unknown>;
type ResultBag = Record<string, unknown> & {
  reserved?: boolean;
  core?: { url: string };
  regions?: Record<string, unknown>;
};

// Match serviceInfo.{register,api,access} convention (slash-terminated).
// Naive `host + 'users'` concatenation in clients/tests would otherwise
// produce `https://single.example.devusers`. coreIdToUrl() normalizes
// internally; this helper covers the two ApiEndpoint.build() fallback
// sites below that bypass it.
function withTrailingSlash (url: string | null | undefined): string | null | undefined {
  if (url == null || url === '') return url;
  return url.endsWith('/') ? url : url + '/';
}

/**
 * Auth API methods implementations.
 *
 */
export default async function (api: { register: (...args: unknown[]) => void }) {
  const config = await ready();
  const storageLayer = await getStorageLayer();
  // Pass a lazy getter to Registration instead of a captured slice so
  // the welcome-mail send path reads live `services` config per-use.
  const getServicesSettings = () => config.get('services');
  const usersRepository = await getUsersRepository();
  const passwordRules = await getPasswordRules();
  // REGISTER
  const registration = new Registration(null, storageLayer, getServicesSettings);
  await registration.init();
  const platform: Platform = await getPlatform();

  api.register('auth.register',
    setAuditAccessId(AuditAccessIds.PUBLIC),
    commonFns.getParamsValidation(methodsSchema.register.params),
    enforcePasswordRules,
    registration.prepareUserData.bind(registration),
    // Registration email gate: refuse an unproved address BEFORE any cross-core
    // forward, so the landing core never proxies a request the target would reject.
    registration.requireEmailProof.bind(registration),
    // in multi-core mode, if the selected hosting maps
    // to a different core, transparently HTTPS-proxy the POST to the
    // target core and return its response. Atomic on target; clients
    // don't need to re-POST.
    registration.forwardIfCrossCore.bind(registration),
    registration.validateOnPlatform.bind(registration),
    registration.createUser.bind(registration),
    registration.buildResponse.bind(registration),
    registration.sendWelcomeMail.bind(registration));

  async function enforcePasswordRules (_context: MethodContext, params: RegisterParams, _result: ResultBag, next: MethodNext) {
    try {
      await passwordRules.checkNewPassword(null, params.password);
      next();
    } catch (err) {
      return next(err);
    }
  }

  // Username check
  api.register('auth.usernameCheck',
    setAuditAccessId(AuditAccessIds.PUBLIC),
    commonFns.getParamsValidation(methodsSchema.usernameCheck.params),
    checkUsername);

  // Email / unique field check
  api.register('auth.emailCheck',
    setAuditAccessId(AuditAccessIds.PUBLIC),
    commonFns.getParamsValidation(methodsSchema.emailCheck.params),
    checkUniqueField);

  /**
   * Check if username is taken
   */
  async function checkUsername (_context: MethodContext, params: CheckUsernameParams, result: ResultBag, next: MethodNext) {
    result.reserved = await usersRepository.usernameExistsOnPlatform(params.username);
    if (result.reserved == null) {
      return next(errors.unexpectedError('username reserved cannot be null'));
    }
    next();
  }

  /**
   * Check if a unique field value is already taken (email, etc.)
   */
  async function checkUniqueField (_context: MethodContext, params: CheckUniqueParams, result: ResultBag, next: MethodNext) {
    result.reserved = false;
    const field = Object.keys(params)[0];
    if (field === 'username') {
      if (await usersRepository.usernameExistsOnPlatform(params[field])) {
        return next(errors.itemAlreadyExists('user', { username: params[field] }));
      }
    }
    const value = await platform.getUsersUniqueField(field, params[field]);
    if (value != null) {
      return next(errors.itemAlreadyExists('user', { [field]: params[field] }));
    }
    next();
  }

  // Registration email challenge: issue a one-time code to an address, then
  // exchange a correct code for a short-lived proof that `auth.register`
  // requires. Both are public and inert unless the operator turned the gate on.
  api.register('auth.emailChallenge',
    setAuditAccessId(AuditAccessIds.PUBLIC),
    commonFns.getParamsValidation(methodsSchema.emailChallenge.params),
    requireGateOn,
    refuseTakenAddress,
    createAndMailChallenge);

  api.register('auth.emailChallengeVerify',
    setAuditAccessId(AuditAccessIds.PUBLIC),
    commonFns.getParamsValidation(methodsSchema.emailChallengeVerify.params),
    requireGateOn,
    verifyChallengeCode);

  // Operator-facing text for each throttle outcome. The reason is also returned
  // as data so a client can tell "wait a moment" from "come back tomorrow".
  const THROTTLE_MESSAGES: Record<string, string> = {
    cooldown: 'Please wait before requesting another verification code.',
    'daily-limit': 'Too many verification codes were requested for this address today. Please try again later.',
    'failure-budget': 'Too many failed verification attempts for this address. Please try again later.'
  };

  async function requireGateOn (_context: MethodContext, _params: unknown, _result: ResultBag, next: MethodNext) {
    try {
      if (!(await policy.isRegistrationVerificationRequired())) {
        return next(errors.forbidden('Email verification at registration is not enabled on this platform.', { emailVerificationRequired: false }));
      }
      next();
    } catch (err) {
      return next(err);
    }
  }

  // Do not mint a code for an address that already belongs to an account: the
  // challenge only exists to prove an address on the way to creating one.
  async function refuseTakenAddress (_context: MethodContext, params: EmailChallengeParams, _result: ResultBag, next: MethodNext) {
    try {
      if ((await platform.getUsersUniqueField('email', params.email)) != null) {
        return next(errors.itemAlreadyExists('user', { email: params.email }));
      }
      next();
    } catch (err) {
      return next(err);
    }
  }

  async function createAndMailChallenge (_context: MethodContext, params: EmailChallengeParams, result: ResultBag, next: MethodNext) {
    try {
      const outcome = await challenge.createChallenge(params.email);
      if (!outcome.ok) {
        return next(errors.tooManyAttempts(outcome.retryAfterSeconds, {
          message: THROTTLE_MESSAGES[outcome.reason],
          data: { reason: outcome.reason, retryAfterSeconds: outcome.retryAfterSeconds }
        }));
      }
      try {
        await deliverEmailChallenge(params.email, params.language, outcome.code, outcome.expiresAt);
      } catch (err) {
        // The code was minted but never reached the address: release the row
        // and the cooldown slot so the caller can retry immediately.
        await challenge.discardChallenge(params.email);
        return next(err);
      }
      result.sent = true;
      next();
    } catch (err) {
      return next(err);
    }
  }

  // Deliver one challenge mail. The plaintext code lives only in this call; it
  // is never logged and (unlike the link flow) never put in the subject.
  function deliverEmailChallenge (email: string, lang: string | undefined, code: string, expiresAt: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const emailSettings = config.get('services:email');
      const recipient = { email, name: email, type: 'to' };
      const substitutions = {
        CODE: challenge.formatCode(code),
        EMAIL: email,
        CODE_MAX_AGE_MINUTES: String(Math.max(1, Math.round((expiresAt - Date.now()) / 60000)))
      };
      mailing.sendmail(emailSettings, emailSettings.emailChallengeTemplate || 'email-challenge', recipient, substitutions,
        lang || emailSettings.defaultLang || 'en',
        (err?: Error | null) => (err != null ? reject(err) : resolve()));
    });
  }

  async function verifyChallengeCode (_context: MethodContext, params: EmailChallengeVerifyParams, result: ResultBag, next: MethodNext) {
    try {
      const outcome = await challenge.verifyChallenge(params.email, params.code);
      if (outcome.ok) {
        result.emailProof = outcome.proof;
        return next();
      }
      if (outcome.reason === 'exhausted') {
        return next(errors.tooManyAttempts(undefined, {
          message: 'Too many failed attempts for this code. Request a new code.',
          data: { reason: 'exhausted' }
        }));
      }
      // Uniform answer for "no challenge" and "wrong code" so the endpoint does
      // not disclose whether a challenge is pending for the address.
      const err = errors.invalidAccessToken('The verification code is invalid or expired.');
      err.data = { attemptsRemaining: outcome.attemptsRemaining };
      return next(err);
    } catch (err) {
      return next(err);
    }
  }

  // Core discovery — find which core hosts a given user
  const { ApiEndpoint } = require('utils');

  api.register('auth.cores',
    setAuditAccessId(AuditAccessIds.PUBLIC),
    coresLookup);

  async function coresLookup (_context: MethodContext, params: CoresParams, result: ResultBag, next: MethodNext) {
    if (params.username == null && params.email == null) {
      return next(errors.invalidParametersFormat('provide "username" or "email" as query parameter'));
    }
    if (params.username != null && params.email != null) {
      return next(errors.invalidParametersFormat('provide only "username" or "email", not both'));
    }

    // Schema validation guarantees username xor email is present.
    let username: string | null | undefined = params.username;
    // True when `username` came from the email→PlatformDB lookup and is
    // therefore already in PlatformDB storage form (HMAC token in hashed
    // mode). Determines whether subsequent platform calls use the
    // plaintext-taking or pre-hashed Platform variants.
    let usernameIsPreHashed = false;

    // Resolve email → username via PlatformDB unique field. The returned
    // value is the row VALUE: plaintext username in cleartext mode,
    // HMAC-username token in hashed mode (B.2 chained-lookup contract).
    if (params.email != null) {
      username = await platform.getUsersUniqueField('email', params.email);
      if (username == null) {
        // Unknown email — return self URL (client can attempt registration)
        result.core = { url: (withTrailingSlash(platform.coreUrl || ApiEndpoint.build('', null)) || '') as string };
        return next();
      }
      usernameIsPreHashed = platform.piiModeIsHashed;
    }

    // Multi-core: look up which core hosts this user via shared PlatformDB.
    if (!platform.isSingleCore) {
      const userCoreId = usernameIsPreHashed
        ? await platform.getUserCoreByPreHashedUsername(username!)
        : await platform.getUserCore(username!);
      if (userCoreId != null) {
        result.core = { url: platform.coreIdToUrl(userCoreId) };
        return next();
      }
      // User not in PlatformDB — unknown
      return next(errors.unknownResource('user', username));
    }

    // Single-core: check local users_index. The repository wants a
    // PLAINTEXT username — in hashed mode the email→username path
    // can't supply that (cleartext lives only on the home core's
    // user-account storage), so we degrade to "unknown" rather than
    // double-look up against a HMAC token.
    if (usernameIsPreHashed) {
      // Hashed-mode single-core: there is no plaintext to feed
      // usersRepository.usernameExists; surface unknown so the client
      // re-tries with username input instead of email.
      return next(errors.unknownResource('user', '<hashed>'));
    }
    if (!(await usersRepository.usernameExists(username))) {
      return next(errors.unknownResource('user', username));
    }
    result.core = { url: ApiEndpoint.build(username, null) };
    next();
  }

  // Hostings — available cores (regions/zones/hostings hierarchy)
  api.register('auth.hostings',
    setAuditAccessId(AuditAccessIds.PUBLIC),
    hostingsLookup);

  async function hostingsLookup (_context: MethodContext, _params: HostingsParams, result: ResultBag, next: MethodNext) {
    try {
      const configHostings = config.get('hostings') as { regions?: Record<string, unknown> } | undefined;
      const allCores = await platform.getAllCoreInfos();

      // Build hosting → available core URL map
      const hostingCores: Record<string, Array<{ id: string; [k: string]: unknown }>> = {};
      for (const core of allCores) {
        if (core.available === false) continue;
        const h = core.hosting || 'default';
        if (!hostingCores[h]) hostingCores[h] = [];
        hostingCores[h].push(core);
      }

      if (configHostings != null && configHostings.regions != null) {
        // Use configured hierarchy, enrich with availability from PlatformDB
        type Hosting = { available?: boolean, availableCore?: string };
        type Zone = { hostings?: Record<string, Hosting> };
        type Region = { zones?: Record<string, Zone> };
        const regions: Record<string, Region> = JSON.parse(JSON.stringify(configHostings.regions));
        for (const region of Object.values(regions)) {
          for (const zone of Object.values(region.zones || {})) {
            for (const [hKey, hosting] of Object.entries(zone.hostings || {})) {
              const cores = hostingCores[hKey] || [];
              hosting.available = cores.length > 0;
              hosting.availableCore = cores.length > 0
                ? platform.coreIdToUrl(cores[0].id)
                : '';
            }
          }
        }
        result.regions = regions;
      } else {
        // Auto-generate minimal hierarchy for single-core / unconfigured
        const selfUrl = withTrailingSlash(platform.coreUrl || ApiEndpoint.build('', null));
        result.regions = {
          default: {
            name: 'Default',
            zones: {
              default: {
                name: 'Default',
                hostings: {
                  default: {
                    name: 'Default',
                    available: true,
                    availableCore: selfUrl
                  }
                }
              }
            }
          }
        };
      }
      next();
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
  }
};
