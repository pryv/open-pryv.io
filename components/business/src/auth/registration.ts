/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Logger } from '@pryv/boiler';
const require = createRequire(import.meta.url);
const { errorHandling } = require('errors');
const mailing = require('api-server/src/methods/helpers/mailing.ts');
const { getPlatform } = require('platform');
const accountStreams = require('business/src/system-streams/index.ts');
const { User } = require('business/src/users/index.ts');
const { getLogger } = require('@pryv/boiler');
const { ApiEndpoint } = require('utils');
const observability = require('business/src/observability/index.ts');

/**
 * Create (register) a new user
 */
type Platform = {
  isSingleCore: boolean;
  coreId: string;
  selectCoreForRegistration: (hosting: unknown) => Promise<string | null>;
  coreIdToUrl: (id: string) => string;
  validateRegistration: (username: string, invitationToken: unknown, uniqueFields: Record<string, unknown>, hosting: unknown) => Promise<{ redirect?: string } | undefined>;
  consumeInvitationToken: (token: string, username: string) => Promise<unknown>;
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
  [k: string]: unknown;
};
type ResultBag = Record<string, unknown> & { forwarded?: boolean; redirect?: string; core?: { url: string }; username?: string; apiEndpoint?: string; id?: string };
type Next = (err?: unknown) => void;
type ApiError = Error & { id?: string; httpStatus?: number };

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
    try {
      if (!this.platform || this.platform.isSingleCore) return next();
      const selectedCoreId = await this.platform.selectCoreForRegistration(params.hosting);
      if (selectedCoreId == null || selectedCoreId === this.platform.coreId) {
        return next();
      }
      // Label the transaction in APM so local vs forwarded registrations
      // are distinguishable in the UI. No-op when no provider is attached.
      observability.setTransactionName('auth.register.forwarded');
      const targetUrl = this.platform.coreIdToUrl(selectedCoreId);
      // 30 s timeout: a hung target must not wedge the landing worker.
      // 30 s matches Node fetch's default connect timeout + leaves headroom
      // for password-hashing cost on the target.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      let response;
      try {
        // targetUrl is slash-terminated (Platform.coreIdToUrl convention).
        response = await fetch(targetUrl + 'users', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const err: ApiError = new Error(body?.error?.message || ('Cross-core registration forward failed: ' + response.status));
        err.id = body?.error?.id || 'cross-core-registration-failed';
        err.httpStatus = response.status;
        return next(err);
      }
      // Strip the target's `meta` block — the local api-server will add
      // its own meta on the way out. Copy every other field into result.
      const { meta, ...fields } = body;
      Object.assign(result, fields);
      result.forwarded = true;
      return next();
    } catch (err) {
      observability.recordError(err, { context: 'auth.register.forward' });
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
        params.hosting
      );
      // Multi-core: if registration should happen on another core, return redirect
      if (validation?.redirect) {
        result.redirect = validation.redirect;
        return next();
      }
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
    // if it is testing user, skip registration process
    if (context.newUser.username === 'backloop') {
      result.id = 'dummy-test-user';
      context.newUser.id = result.id;
      context.user.username = context.newUser.username;
      return next();
    }
    try {
      const { getUsersRepository } = require('business/src/users/index.ts');
      const usersRepository = await getUsersRepository();
      // insertOne handles PlatformDB storage (unique + indexed fields) internally
      await usersRepository.insertOne(context.newUser, true);
    } catch (err) {
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
    // Consume invitation token on successful registration
    if (context.newUser.invitationToken) {
      await this.platform.consumeInvitationToken(
        context.newUser.invitationToken as string,
        context.newUser.username
      );
    }
    result.username = context.newUser.username;
    result.apiEndpoint = ApiEndpoint.build(context.newUser.username, context.newUser.token as string | undefined);
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
    // Phase D: on a fresh bundle-bootstrapped core, `services.email` may
    // be absent entirely; the previous code threw
    // "Cannot read properties of undefined (reading 'enabled')" and
    // failed the whole registration response even though createUser had
    // already succeeded.
    if (!emailSettings) return next();
    // Skip this step if welcome mail is deactivated
    const emailActivation = emailSettings.enabled as { welcome?: boolean } | boolean | undefined;
    if (typeof emailActivation === 'object' && emailActivation?.welcome === false) {
      return next();
    }
    const recipient = {
      email: context.newUser.email,
      name: context.newUser.username,
      type: 'to'
    };
    const substitutions = {
      USERNAME: context.newUser.username,
      EMAIL: context.newUser.email
    };
    mailing.sendmail(emailSettings, emailSettings.welcomeTemplate, recipient, substitutions, context.newUser.language, (err: Error | null) => {
      // Don't fail creation process itself (mail isn't critical), just log error
      if (err) {
        errorHandling.logError(err, null, this.logger);
      }
    });
    next();
  }
}
export default Registration;
export { Registration };