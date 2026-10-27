/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Logger } from '@pryv/boiler';
import type { FlowExternalId, RegistrationClaim } from 'business/src/external-ids/service.ts';
const require = createRequire(import.meta.url);
const { APIError } = require('errors');
const errors = require('errors').factory;
const mailing = require('api-server/src/methods/helpers/mailing.ts');
const challenge = require('business/src/emails/challenge.ts');
const policy = require('business/src/emails/registrationPolicy.ts');
const C = require('business/src/emails/constants.ts');
const timestamp = require('unix-timestamp');
const { getPlatform } = require('platform');
const accountStreams = require('business/src/system-streams/index.ts');
const emailsContainer = require('business/src/emails/container.ts');
const { foundingVerifyLink } = require('business/src/emails/verifyLink.ts');
const { User } = require('business/src/users/index.ts');
const { getLogger, getConfigSync } = require('@pryv/boiler');
const { REGISTRATION_FORWARD_HEADER, signRegistrationForward } = require('business/src/auth/registrationForward.ts');
const { peerUrlProblem, peerFetchOptions, insecurePeerUrlAllowed } = require('platform/src/coreIdentity.ts');
const { ApiEndpoint } = require('utils');

/**
 * Create (register) a new user
 */
type Platform = {
  isSingleCore: boolean;
  coreId: string;
  selectCoreForRegistration: (hosting: unknown) => Promise<string | null>;
  coreIdToUrl: (id: string) => string;
  validateRegistration: (username: string, invitationToken: unknown, uniqueFields: Record<string, unknown>, hosting: unknown, options?: { pinToSelf?: boolean }) => Promise<{ redirect?: string; invitationClaimed?: boolean } | undefined>;
  releaseInvitationToken: (token: string, username: string) => Promise<void>;
};
type ServicesSettings = { email?: { enabled?: boolean | { welcome?: boolean; resetPassword?: boolean }; welcomeTemplate?: string; [k: string]: unknown }; [k: string]: unknown };
type SystemStreamSettings = { isUnique?: boolean; isShown?: boolean; [k: string]: unknown };
type NewUserLike = {
  id: string;
  username: string;
  password?: string;
  passwordHash?: string;
  [k: string]: unknown;
};
type MethodContext = {
  newUser: NewUserLike;
  user: { id: string; username: string };
  emailProofVerified?: boolean;
  invitationClaimed?: boolean;
  /** The registration's validated external id (validateOnPlatform). */
  externalIdField?: FlowExternalId;
  /** Set when the registration carries an external id and this core holds its platform row. */
  externalIdClaim?: RegistrationClaim;
  /** Set once the account is written: whether the id is linked to it. */
  externalIdLinked?: boolean;
  [k: string]: unknown;
};
type RegisterParams = {
  username?: string;
  password?: string;
  passwordHash?: string;
  appId?: string;
  email?: string;
  hosting?: unknown;
  invitationToken?: unknown;
  emailProof?: string;
  externalId?: unknown;
  [k: string]: unknown;
};
type ResultBag = Record<string, unknown> & { forwarded?: boolean; redirect?: string; core?: { url: string }; username?: string; apiEndpoint?: string; id?: string };
type Next = (err?: unknown) => void;

// Loaded on first use: the service reaches the platform and the storage
// engines, which are not ready when this module loads.
async function externalIdsService () {
  const { getExternalIdsService } = await import('business/src/external-ids/service.ts');
  return await getExternalIdsService();
}

class Registration {
  logger: Logger;

  storageLayer: unknown;
  /** @default accountStreams.accountMap */
  accountStreamsSettings: Record<string, SystemStreamSettings> = accountStreams.accountMap;

  // 0-arg getter returning the current `services` config slice. Stored
  // as a function (not a snapshot object) so the welcome-mail send path
  // reads live config at request time.
  getServicesSettings: () => ServicesSettings;

  platform!: Platform;
  constructor (_logging: unknown, storageLayer: unknown, servicesSettings: ServicesSettings | (() => ServicesSettings)) {
    this.logger = getLogger('business:registration');
    this.storageLayer = storageLayer;
    // Accept either a literal settings object (legacy) or a 0-arg getter
    // function. When a getter is passed, services config is resolved per-use
    // from the live config singleton — config.set() and injectTestConfig()
    // reach the welcome-mail send path without a restart, and a plugin or
    // override that adds keys later becomes visible.
    this.getServicesSettings = typeof servicesSettings === 'function' ? servicesSettings : () => servicesSettings;
  }

  async init () {
    if (this.platform == null) {
      this.platform = await getPlatform();
    }
    return this;
  }

  /**
   * Do minimal manipulation with data like username conversion to lowercase
   */
  async prepareUserData (context: MethodContext, params: RegisterParams, result: ResultBag, next: Next) {
    context.newUser = new User(params);
    // accept passwordHash at creation only (used by system.createUser)
    context.newUser.passwordHash = params.passwordHash;
    context.user = {
      id: context.newUser.id,
      username: context.newUser.username
    };
    next();
  }

  /**
   * Registration email gate. When the operator requires a verified address at
   * sign-up, the request must carry the proof issued by the email-challenge
   * verify step for the SAME address. Non-consuming: the proof is consumed
   * only after the user row is committed (createUser), so a username conflict
   * or a cross-core forward never burns it. Runs before forwardIfCrossCore.
   */
  async requireEmailProof (context: MethodContext, params: RegisterParams, result: ResultBag, next: Next) {
    try {
      if (!(await policy.isRegistrationVerificationRequired())) return next();
      if (typeof params.email !== 'string' || params.email.trim() === '') {
        return next(errors.invalidParametersFormat('An email address is required to create an account on this platform.', { emailVerificationRequired: true }));
      }
      const proof = params.emailProof;
      if (typeof proof !== 'string' || !(await challenge.checkProof(params.email, proof))) {
        return next(errors.forbidden('Email address not verified: request a verification code and verify it first.', { emailVerificationRequired: true }));
      }
      context.emailProofVerified = true;
      next();
    } catch (err) {
      next(err);
    }
  }

  /**
   * Multi-core cross-core forward.
   *
   * When the selected hosting maps to a different core than the landing
   * core, proxy the POST body to the target core's /users endpoint and
   * return its response to the client transparently. This keeps
   * registration atomic on the target (unique-field reservation,
   * user-core assignment, user creation, welcome mail all happen there)
   * and avoids the earlier "orphaned user-core + empty PG" failure mode
   * where non-compliant SDKs ignored the redirect payload.
   *
   * Downstream chain steps must no-op when `result.forwarded` is set.
   */
  async forwardIfCrossCore (context: MethodContext, params: RegisterParams, result: ResultBag, next: Next) {
    // A forward that could not be completed: 503 for the client, the target's
    // answer or the network cause for the log only. Logged at warn here: the
    // API error log records a non-500 at info, below an operator's level.
    const logger = this.logger;
    function forwardFailed (message: string, detail: string) {
      const inner = new Error('Cross-core registration forward: ' + detail);
      logger.warn(inner.message);
      return new APIError('cross-core-registration-failed', message, { httpStatus: 503, innerError: inner });
    }
    try {
      if (!this.platform || this.platform.isSingleCore) return next();
      // Forwarded here by another core: create the account here, never forward again.
      if (context.registrationForwardedFrom != null) return next();
      const selectedCoreId = await this.platform.selectCoreForRegistration(params.hosting);
      if (selectedCoreId == null || selectedCoreId === this.platform.coreId) {
        return next();
      }
      const targetUrl = this.platform.coreIdToUrl(selectedCoreId);
      const config = getConfigSync();
      const urlProblem = peerUrlProblem(targetUrl, { allowInsecure: insecurePeerUrlAllowed(config) });
      if (urlProblem != null) throw new Error('Cross-core registration forward refused: ' + urlProblem);
      // The target checks this signature, then records the client address the
      // landing core saw and creates the account itself.
      const forwardedBody = JSON.stringify(params);
      const client = String((context.source as { ip?: string } | undefined)?.ip ?? '');
      const key = config.get('auth:adminAccessKey');
      if (typeof key !== 'string' || key.length === 0) throw new Error('Cross-core registration forward refused: auth.adminAccessKey is not set');
      const forward = signRegistrationForward(key, this.platform.coreId, client, forwardedBody);
      // 30 s timeout: a hung target must not wedge the landing worker (leaves
      // headroom for password-hashing cost on the target); redirects refused.
      // targetUrl is slash-terminated (Platform.coreIdToUrl convention).
      let response;
      try {
        response = await fetch(targetUrl + 'users', peerFetchOptions({
          method: 'POST',
          headers: { 'content-type': 'application/json', [REGISTRATION_FORWARD_HEADER]: forward },
          body: forwardedBody
        }, 30000));
      } catch (err) {
        // Unreachable, timed out or redirecting: the registration was not
        // refused, it could not be placed. The network cause (ECONNREFUSED,
        // ENOTFOUND, ...) sits on `cause`, which the log would not show.
        const cause = (err as { cause?: { message?: string } })?.cause?.message ?? (err as Error)?.message;
        return next(forwardFailed('The core selected for this registration is unreachable.',
          selectedCoreId + ' at ' + targetUrl + ': ' + cause));
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        // A refusal of the registration (a 4xx carrying an API error id)
        // reaches the client as the target answered it: its body is already
        // the public error data. A 401/403 is the target refusing the forward
        // itself (cores not sharing the admin key), a 4xx with no API error
        // id is not the target answering (e.g. a proxy's HTML 404 for a wrong
        // core URL), and a 5xx is the target's own fault: none is the
        // client's, and none is relayed. Always an APIError: a plain Error
        // would become a 500 unexpected-error.
        const relayed = response.status >= 400 && response.status < 500 &&
          response.status !== 401 && response.status !== 403 &&
          typeof body?.error?.id === 'string';
        if (relayed) {
          return next(new APIError(body.error.id,
            typeof body.error.message === 'string' ? body.error.message : 'The registration was refused.',
            { httpStatus: response.status, data: body.error.data }));
        }
        return next(forwardFailed('The core selected for this registration did not accept it.',
          selectedCoreId + ' answered ' + response.status + ' ' + (body?.error?.id ?? '(not an API error)')));
      }
      // Strip the target's `meta` block — the local api-server will add
      // its own meta on the way out. Copy every other field into result.
      const { meta, ...fields } = body;
      Object.assign(result, fields);
      result.forwarded = true;
      return next();
    } catch (err) {
      // The failure travels the API chain, where the telemetry choke point
      // counts and reports it under `auth.register`.
      return next(err);
    }
  }

  /**
   * Validate registration on PlatformDB:
   * - Check invitation token
   * - Check reserved usernames
   * - Check username + unique field availability (atomically reserved)
   */
  async validateOnPlatform (context: MethodContext, params: RegisterParams, result: ResultBag, next: Next) {
    if (result.forwarded) return next();
    try {
      // External id: validated before anything is reserved, claimed right
      // before the account is written (createUser).
      const externalIdField = params.externalId != null
        ? await (await externalIdsService()).parseFlowField(params.externalId)
        : null;
      // Forced mode: an id held anywhere refuses the registration before
      // anything is reserved (the patient already has an account).
      if (externalIdField?.mode === 'forced' && await (await externalIdsService()).isClaimed(externalIdField)) {
        throw errors.externalIdAlreadyClaimed(externalIdField.namespace, 'value-taken');
      }
      const uniqueFields: Record<string, unknown> = { username: context.newUser.username };
      for (const [streamIdWithPrefix, streamSettings] of Object.entries(this.accountStreamsSettings)) {
        if (streamSettings?.isUnique) {
          const fieldName = accountStreams.toFieldName(streamIdWithPrefix);
          uniqueFields[fieldName] = context.newUser[fieldName];
        }
      }
      const validation = await this.platform.validateRegistration(
        context.newUser.username,
        context.newUser.invitationToken,
        uniqueFields,
        params.hosting,
        // Forwarded by another core, which selected this one: create here.
        { pinToSelf: context.registrationForwardedFrom != null }
      );
      // Multi-core: if registration should happen on another core, return redirect
      if (validation?.redirect) {
        result.redirect = validation.redirect;
        return next();
      }
      // The invitation token is now consumed; given back if creation fails.
      context.invitationClaimed = validation?.invitationClaimed === true;
      if (externalIdField != null) context.externalIdField = externalIdField;
    } catch (error) {
      return next(error);
    }
    next();
  }

  /**
   * Save user to the database, then store indexed fields in PlatformDB
   */
  async createUser (context: MethodContext, params: RegisterParams, result: ResultBag, next: Next) {
    // Multi-core: either legacy redirect flow OR new transparent forward
    // already returned the target's response — nothing to do locally.
    if (result.redirect || result.forwarded) return next();
    try {
      const { getUsersRepository } = require('business/src/users/index.ts');
      const usersRepository = await getUsersRepository();
      // Hint mode: the external id is claimed for this core when nobody holds
      // it, in the same failure domain as the account write: a failing claim
      // gives back what validateRegistration reserved, as a failed insert does.
      if (context.externalIdField != null) {
        try {
          context.externalIdClaim = await (await externalIdsService()).reserveAtRegistration(context.externalIdField);
          // Forced mode: taken between the pre-check and the claim. Refused
          // with the full give-back, never an unlinked account.
          if (context.externalIdField.mode === 'forced' && !context.externalIdClaim.platformClaimed) {
            throw errors.externalIdAlreadyClaimed(context.externalIdField.namespace, 'value-taken');
          }
        } catch (reserveErr) {
          await usersRepository.compensateFailedInsert(context.newUser);
          throw reserveErr;
        }
      }
      // insertOne handles PlatformDB storage (unique + indexed fields) internally
      await usersRepository.insertOne(context.newUser, true);
      if (context.externalIdClaim != null) {
        // Best-effort, like the seeds below: the account is written; an id
        // that could not be linked leaves it unlinked (and the reconcile
        // finishes a half-done claim).
        try {
          context.externalIdLinked = await (await externalIdsService()).linkAtRegistration(context.newUser.id as string, context.externalIdClaim);
        } catch (linkErr) {
          context.externalIdLinked = false;
          getLogger('registration').warn('external id not linked at registration', {
            username: context.newUser.username,
            error: linkErr instanceof Error ? linkErr.message : String(linkErr)
          });
        }
      }
      // Gate: the proof is consumed only now that the user row exists; the
      // founding email is then proved by code, not merely asserted.
      let provenance: { verificationMethod: string; verifiedAt: number | null } | undefined;
      if (context.emailProofVerified === true && context.newUser.email != null) {
        provenance = { verificationMethod: C.METHOD_EMAIL_CODE, verifiedAt: timestamp.now() };
        // Best-effort, like the seed below: the account row is already
        // committed, so failing the response here would tell the caller the
        // registration failed and send them into a username conflict on retry.
        // The proof expires on its own TTL, and consuming it is idempotent.
        try {
          await challenge.consumeProof(context.newUser.email as string);
        } catch (consumeErr) {
          getLogger('registration').warn('failed to consume the registration email proof', {
            username: context.newUser.username,
            error: consumeErr instanceof Error ? consumeErr.message : String(consumeErr)
          });
        }
      }
      // Seed the multi-email container: the initial email is primary and
      // verified at today's trust level (no verification method) unless the
      // registration gate proved it by code. The PlatformDB row is already
      // owned by the user (created by insertOne), so this reserves nothing.
      // Best-effort: a container-seed failure must not fail an
      // otherwise-successful registration; existing users without a container
      // are handled by account.get's synthesize fallback anyway.
      if (context.newUser.id != null && context.newUser.email != null) {
        try {
          await emailsContainer.seedInitial(context.newUser.id, context.newUser.email, undefined, provenance);
        } catch (seedErr) {
          getLogger('registration').warn('failed to seed emails container', {
            username: context.newUser.username,
            error: seedErr instanceof Error ? seedErr.message : String(seedErr),
            ...(provenance != null ? { lostProvenance: provenance.verificationMethod } : {})
          });
        }
      }
    } catch (err) {
      if (context.invitationClaimed === true) {
        await this.platform.releaseInvitationToken(context.newUser.invitationToken as string, context.newUser.username);
      }
      if (context.externalIdClaim != null && context.externalIdLinked == null) {
        await (await externalIdsService()).releaseRegistrationClaim(context.externalIdClaim);
      }
      return next(err);
    }
    next();
  }

  /**
   * Build response for user registration
   */
  async buildResponse (context: MethodContext, params: RegisterParams, result: ResultBag, next: Next) {
    // Transparent cross-core forward: target's response already in result.
    // Keep `result.forwarded` set so sendWelcomeMail skips (target core
    // already triggered the welcome email); strip it in the final
    // response-shaping step instead (or let it be — the HTTP response
    // schema's additionalProperties=false would reject it, so we strip
    // just before returning).
    if (result.forwarded) {
      return next();
    }
    // Legacy redirect: tell client to re-register on the correct core.
    // Kept for any v1-era SDK that still expects this shape.
    if (result.redirect) {
      result.core = { url: result.redirect };
      delete result.redirect;
      return next();
    }
    result.username = context.newUser.username;
    result.apiEndpoint = ApiEndpoint.build(context.newUser.username, context.newUser.token as string | undefined);
    // Whether the registration's external id is linked to the new account
    // (false: another account holds it; the app sends the user to sign in).
    if (context.externalIdClaim != null) result.externalIdLinked = context.externalIdLinked === true;
    next();
  }

  /**
   * Send welcome email
   */
  sendWelcomeMail (context: MethodContext, params: RegisterParams, result: ResultBag, next: Next) {
    // Multi-core redirect: no user created locally, skip mail
    if (result.core && !result.username) return next();
    // Transparent cross-core forward: target core already sent the mail.
    // Skip here so the user doesn't get two welcome emails from two
    // different cores.
    if (result.forwarded) {
      delete result.forwarded;
      return next();
    }
    const emailSettings = this.getServicesSettings()?.email;
    // No email service configured → skip welcome mail silently.
    // On a fresh bundle-bootstrapped core, `services.email` may
    // be absent entirely; the previous code threw
    // "Cannot read properties of undefined (reading 'enabled')" and
    // failed the whole registration response even though createUser had
    // already succeeded.
    if (!emailSettings) return next();
    // Skip this step if welcome mail is deactivated
    const emailActivation = emailSettings.enabled as { welcome?: boolean } | boolean | undefined;
    if (emailActivation === false ||
        (typeof emailActivation === 'object' && emailActivation?.welcome === false)) {
      return next();
    }
    const recipient = {
      email: context.newUser.email,
      name: context.newUser.username,
      type: 'to'
    };
    const substitutions: Record<string, unknown> = {
      USERNAME: context.newUser.username,
      EMAIL: context.newUser.email
    };
    // In the background, like the mail itself: when the founding address is
    // not proved (no code at registration) and the verification mail is on,
    // the welcome mail also carries VERIFY_LINK. A failure there sends the
    // plain welcome mail.
    const { id, username, email } = context.newUser;
    (async () => {
      if (id != null && email != null) {
        try {
          const verify = await foundingVerifyLink(id as string, username as string, email as string);
          if (verify != null) Object.assign(substitutions, verify);
        } catch (err) {
          this.logger.warn('welcome mail sent without a verification link', {
            username, error: err instanceof Error ? err.message : String(err)
          });
        }
      }
      mailing.sendmail(emailSettings, emailSettings.welcomeTemplate, recipient, substitutions, context.newUser.language, (err: Error | null) => {
        // The account exists and the 201 is on its way: a failed welcome mail
        // is logged once, by sendmail itself (warn for a refused recipient,
        // error otherwise), never as an unexpected error of this request.
        if (err && !mailing.isLoggedMailFailure(err)) {
          this.logger.error('welcome mail not sent: ' + err.message, { username });
        }
      });
    })().catch((err: unknown) => {
      // Defensive: the account exists and the response is sent, so a throw
      // here is logged, never crashes, and is not an error of the request.
      this.logger.error('welcome mail not sent: ' + (err instanceof Error ? err.message : String(err)), { username });
    });
    next();
  }
}
export default Registration;
export { Registration };
