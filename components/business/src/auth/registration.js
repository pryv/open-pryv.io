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
   * Validate registration on PlatformDB:
   * - Check invitation token
   * - Check reserved usernames
   * - Check username + unique field availability (atomically reserved)
   */
  async validateOnPlatform (context, params, result, next) {
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
        uniqueFields
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
    // Multi-core redirect: skip local user creation
    if (result.redirect) return next();
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
    // Multi-core redirect: tell client to re-register on the correct core
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
    const emailSettings = this.servicesSettings.email;
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
