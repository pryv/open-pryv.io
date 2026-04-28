/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const { errorHandling } = require('errors');
const mailing = require('api-server/src/methods/helpers/mailing');
const { getPlatform } = require('platform');
const accountStreams = require('business/src/system-streams');
const { User } = require('business/src/users');
const { getLogger } = require('@pryv/boiler');
const { ApiEndpoint } = require('utils');
const observability = require('business/src/observability');

/**
 * Create (register) a new user
 */
class Registration {
  logger;

  storageLayer;
  /** @default accountStreams.accountMap */
  accountStreamsSettings = accountStreams.accountMap;

  servicesSettings; // settings to get the email to send user welcome email

  platform;
  constructor (logging, storageLayer, servicesSettings) {
    this.logger = getLogger('business:registration');
    this.storageLayer = storageLayer;
    this.servicesSettings = servicesSettings;
  }

  /**
   * @returns {Promise<this>}
   */
  async init () {
    if (this.platform == null) {
      this.platform = await getPlatform();
    }
    return this;
  }

  /**
   * Do minimal manipulation with data like username conversion to lowercase
   */
  async prepareUserData (context, params, result, next) {
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
  async forwardIfCrossCore (context, params, result, next) {
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
        const err = new Error(body?.error?.message || ('Cross-core registration forward failed: ' + response.status));
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
  async validateOnPlatform (context, params, result, next) {
    if (result.forwarded) return next();
    try {
      const uniqueFields = { username: context.newUser.username };
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
  async createUser (context, params, result, next) {
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
      const { getUsersRepository } = require('business/src/users');
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
  async buildResponse (context, params, result, next) {
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
        context.newUser.invitationToken,
        context.newUser.username
      );
    }
    result.username = context.newUser.username;
    result.apiEndpoint = ApiEndpoint.build(context.newUser.username, context.newUser.token);
    next();
  }

  /**
   * Send welcome email
   */
  sendWelcomeMail (context, params, result, next) {
    // Multi-core redirect: no user created locally, skip mail
    if (result.core && !result.username) return next();
    // Transparent cross-core forward: target core already sent the mail.
    // Skip here so the user doesn't get two welcome emails from two
    // different cores.
    if (result.forwarded) {
      delete result.forwarded;
      return next();
    }
    const emailSettings = this.servicesSettings?.email;
    // No email service configured → skip welcome mail silently.
    // Phase D: on a fresh bundle-bootstrapped core, `services.email` may
    // be absent entirely; the previous code threw
    // "Cannot read properties of undefined (reading 'enabled')" and
    // failed the whole registration response even though createUser had
    // already succeeded.
    if (!emailSettings) return next();
    // Skip this step if welcome mail is deactivated
    const emailActivation = emailSettings.enabled;
    if (emailActivation?.welcome === false) {
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
    mailing.sendmail(emailSettings, emailSettings.welcomeTemplate, recipient, substitutions, context.newUser.language, (err) => {
      // Don't fail creation process itself (mail isn't critical), just log error
      if (err) {
        errorHandling.logError(err, null, this.logger);
      }
    });
    next();
  }
}
module.exports = Registration;
