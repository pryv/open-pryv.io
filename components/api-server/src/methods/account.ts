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

/** The user business object loaded from the users repository — the slice
 *  this pipeline touches. */
type UserBusinessLike = {
  id: string;
  username: string;
  email?: string;
  language?: string;
  getLegacyAccount: () => unknown;
  [k: string]: unknown;
};

// Scratchpad fields the account middleware chain stashes on the context,
// named and typed (populated mid-chain, hence all optional).
type MethodContext = BaseMethodContext & {
  resetToken?: string;
  userBusiness?: UserBusinessLike;
  passwordResetRequest?: import('storages/interfaces/baseStorage/PasswordResetRequests.ts').PasswordResetDoc;
  // Multi-email scratchpad, populated mid-chain by account.update.
  emailsOperations?: { add?: string[]; remove?: string[]; setPrimary?: string; resend?: string[] };
  previousEmail?: string | null;
};

type EmailsUserContext = {
  userId: string;
  username: string;
  user: unknown;
  accessId: string;
  legacyEmail: string | null;
};

const errors = require('errors').factory;
const commonFns = require('./helpers/commonFunctions.ts');
const mailing = require('./helpers/mailing.ts');
const methodsSchema = require('../schema/accountMethods.ts');

const { ready, getLogger } = require('@pryv/boiler');
const logger = getLogger('methods:account');
const { pubsub } = require('messages');
const { getStorageLayer } = require('storage');
const { getPlatform } = require('platform');

const { setAuditAccessId, AuditAccessIds } = require('audit/src/MethodContextUtils.ts');

const { ErrorMessages } = require('errors/src/ErrorMessages.ts');
const ErrorIds = require('errors').ErrorIds;
const { getUsersRepository, UserRepositoryOptions, getPasswordRules } = require('business/src/users/index.ts');
const accountStreams = require('business/src/system-streams/index.ts');
const emailsContainer = require('business/src/emails/container.ts');
const emailsOperations = require('business/src/emails/operations.ts');

export default async function (api: { register: (...args: unknown[]) => void }) {
  const config = await ready();
  // Lazy getters instead of slice captures. Each call reads the current
  // config singleton via `.get()` — config.set() and injectTestConfig()
  // reach this factory's request handlers without a restart, and a
  // plugin or override that adds a key after factory init becomes
  // visible at request time. The boot-time REQUIRED_WHEN check
  // guarantees the keys this factory depends on are populated and
  // validated by the time `ready()` resolves.
  const getAuth = () => config.get('auth');
  const getEmail = () => config.get('services:email');
  const storageLayer = await getStorageLayer();
  const passwordResetRequestsStorage = storageLayer.passwordResetRequests;
  const platform = await getPlatform();
  const passwordRules = await getPasswordRules();
  const requireTrustedAppFn = commonFns.getTrustedAppCheck(getAuth);

  const usersRepository = await getUsersRepository();

  // RETRIEVAL

  api.register(
    'account.get',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.get.params),
    addUserBusinessToContext,
    async function (context: MethodContext, _params: unknown, result: ResultBag, next: Next) {
      try {
        // Invariant: addUserBusinessToContext ran earlier in this chain.
        const account = context.userBusiness!.getLegacyAccount() as Record<string, unknown>;
        // Multi-email record. Falls back to synthesizing the array from the
        // legacy field for users whose container has not been seeded yet.
        account.emails = await emailsContainer.listViews(
          context.user.id, account.email as string | null);
        result.account = account;
        next();
      } catch (err) {
        return next(errors.unexpectedError(err));
      }
    }
  );

  // UPDATE

  api.register(
    'account.update',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.update.params),
    splitEmailsOperations,
    validateThatAllFieldsAreEditable,
    updateDataOnPlatform,
    updateAccount,
    syncLegacyEmailToContainer,
    applyEmailsOperations,
    addUserBusinessToContext,
    buildResultData
  );

  // Pull the `emails` operations object out of the legacy field update so the
  // legacy steps below only ever see real account fields (email, language).
  // The value is applied by applyEmailsOperations, after the legacy swap.
  function splitEmailsOperations (context: MethodContext, params: { update: Record<string, unknown> }, _result: ResultBag, next: Next) {
    if (Object.prototype.hasOwnProperty.call(params.update, 'emails')) {
      context.emailsOperations = params.update.emails as MethodContext['emailsOperations'];
      delete params.update.emails;
    }
    next();
  }

  /**
   * Validate if given parameters are allowed for the edit
   *
   */
  function validateThatAllFieldsAreEditable (_context: MethodContext, params: { update: Record<string, unknown> }, _result: ResultBag, next: Next) {
    const accountMap = accountStreams.accountMap;
    Object.keys(params.update).forEach((streamId: string) => {
      const streamIdWithPrefix = accountStreams.toStreamId(streamId);
      if (!accountMap[streamIdWithPrefix]?.isEditable) {
        // if user tries to add new streamId from non editable streamsIds
        return next(errors.invalidOperation(ErrorMessages[ErrorIds.ForbiddenToEditNoneditableAccountFields], { field: streamId }));
      }
    });
    next();
  }

  // CHANGE PASSWORD

  api.register(
    'account.changePassword',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.changePassword.params),
    verifyOldPassword,
    enforcePasswordRules,
    addUserBusinessToContext,
    setPassword
  );

  async function verifyOldPassword (context: MethodContext, params: { oldPassword: string }, _result: ResultBag, next: Next) {
    try {
      const isValid = await usersRepository.checkUserPassword(context.user.id, params.oldPassword);
      if (!isValid) {
        return next(errors.invalidOperation('The given password does not match.'));
      }
      next();
    } catch (err) {
      // handles unexpected errors
      return next(err);
    }
  }

  async function enforcePasswordRules (context: MethodContext, params: { newPassword: string }, _result: ResultBag, next: Next) {
    try {
      await passwordRules.checkCurrentPasswordAge(context.user.id);
      await passwordRules.checkNewPassword(context.user.id, params.newPassword);
      next();
    } catch (err) {
      return next(err);
    }
  }

  // CHANGE USERNAME

  // Operator-configurable cap on how many times a user may change their
  // username (default 2). The previous username(s) stay routable as aliases.
  const getUsernameChangeLimit = () => {
    const limit = getAuth()?.usernameChangeLimit;
    return Number.isInteger(limit) ? limit : 2;
  };

  api.register(
    'account.changeUsername',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.changeUsername.params),
    requirePersonalAccess,
    changeUsername,
    addUserBusinessToContext,
    async function buildChangeUsernameResult (context: MethodContext, _params: unknown, result: ResultBag, next: Next) {
      // Invariant: addUserBusinessToContext ran earlier in this chain.
      result.account = context.userBusiness!.getLegacyAccount();
      next();
    }
  );
  // account.changeUsername is an authenticated personal-token action; it is
  // audited automatically under the caller's access (no setAuditAccessId,
  // which is for unauthenticated flows like password reset).

  api.register(
    'account.usernameChanges',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.usernameChanges.params),
    requirePersonalAccess,
    async function (context: MethodContext, _params: unknown, result: ResultBag, next: Next) {
      try {
        const limit = getUsernameChangeLimit();
        const used = await usersRepository.getUsernameChangeCount(context.user.id);
        result.usernameChangesUsed = used;
        result.usernameChangesLimit = limit;
        result.usernameChangesRemaining = Math.max(0, limit - used);
        next();
      } catch (err) {
        return next(errors.unexpectedError(err));
      }
    }
  );

  function requirePersonalAccess (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    if (!context.access.isPersonal()) {
      return next(errors.forbidden('Changing the username requires a personal access token.'));
    }
    next();
  }

  async function changeUsername (context: MethodContext, params: { newUsername: string }, result: ResultBag, next: Next) {
    try {
      const userId = context.user.id;
      const oldUsername = context.user.username;
      const newUsername = params.newUsername.toLowerCase();

      if (newUsername === oldUsername) {
        return next(errors.invalidOperation('The new username is identical to the current one.'));
      }
      // Enforce the operator's change limit.
      const limit = getUsernameChangeLimit();
      const used = await usersRepository.getUsernameChangeCount(userId);
      if (used >= limit) {
        return next(errors.invalidOperation(
          'Username change limit reached.',
          { usernameChangesUsed: used, usernameChangesLimit: limit }
        ));
      }
      // Reserved words (mirrors registration).
      if (platform.isUsernameReserved(newUsername)) {
        return next(errors.invalidOperation('This username is reserved.', { newUsername }));
      }
      // Availability: reject if the name resolves to ANY user (primary or alias).
      const taken = await usersRepository.getUserIdForUsername(newUsername);
      if (taken != null) {
        return next(errors.itemAlreadyExists('user', { username: newUsername }));
      }

      await usersRepository.changeUsername(userId, oldUsername, newUsername, context.access.id);

      // Keep the context coherent for the downstream result builders.
      context.user.username = newUsername;
      pubsub.notifications.emit(oldUsername, pubsub.USERNAME_BASED_ACCOUNT_CHANGED);
      result.usernameChangesRemaining = Math.max(0, limit - (used + 1));
      next();
    } catch (err) {
      if (err != null && (err as { id?: string }).id === ErrorIds.ItemAlreadyExists) {
        return next(err);
      }
      return next(errors.unexpectedError(err));
    }
  }

  // REQUEST PASSWORD RESET

  api.register(
    'account.requestPasswordReset',
    commonFns.getParamsValidation(methodsSchema.requestPasswordReset.params),
    requireTrustedAppFn,
    generatePasswordResetRequest,
    addUserBusinessToContext,
    sendPasswordResetMail,
    setAuditAccessId(AuditAccessIds.PASSWORD_RESET_REQUEST)
  );

  function generatePasswordResetRequest (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    const username = context.user.username;
    if (username == null) {
      return next(new Error('AF: username is not empty.'));
    }
    passwordResetRequestsStorage.generate(username, function (err: Error | null, token: string) {
      if (err) {
        return next(errors.unexpectedError(err));
      }
      context.resetToken = token;
      next();
    });
  }

  async function addUserBusinessToContext (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    try {
      // get user details
      const usersRepository = await getUsersRepository();
      context.userBusiness = await usersRepository.getUserByUsername(context.user.username);
      if (!context.userBusiness) { return next(errors.unknownResource('user', context.user.username)); }
    } catch (err) {
      return next(err);
    }
    next();
  }

  async function setPassword (context: MethodContext, params: { newPassword: string }, _result: ResultBag, next: Next) {
    try {
      const usersRepository = await getUsersRepository();
      // Invariant: addUserBusinessToContext ran earlier in this chain.
      await usersRepository.setUserPassword(context.userBusiness!.id, params.newPassword, 'system');
      pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_ACCOUNT_CHANGED);
    } catch (err) {
      return next(err);
    }
    next();
  }

  function sendPasswordResetMail (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    // Skip this step if reset mail is deactivated.
    const emailSettings = getEmail();
    const isMailActivated = emailSettings.enabled;
    if (isMailActivated === false ||
            (isMailActivated != null && isMailActivated.resetPassword === false)) {
      return next();
    }
    // The REQUIRED_WHEN boot check guarantees `auth.passwordResetPageURL`
    // is populated when the reset-password email feature is enabled
    // (boot exits with code 1 otherwise). No request-time fallback —
    // boot is the right place to catch missing config, not the
    // per-request mail path.
    const passwordResetPageURL = getAuth().passwordResetPageURL;
    // Invariant: generatePasswordResetRequest ran earlier in this chain.
    const resetLink = passwordResetPageURL + '?resetToken=' + encodeURIComponent(context.resetToken!);
    const recipient = {
      email: context.userBusiness!.email,
      name: context.userBusiness!.username,
      type: 'to'
    };
    const substitutions = {
      RESET_TOKEN: context.resetToken,
      RESET_URL: passwordResetPageURL,
      RESET_LINK: resetLink
    };
    mailing.sendmail(emailSettings, emailSettings.resetPasswordTemplate, recipient, substitutions, context.userBusiness!.language, next);
  }

  // EMAIL VERIFICATION

  // Mirror sendPasswordResetMail's gating: the whole email feature off, or the
  // verifyEmail class specifically off, means no verification mail is sent.
  function isVerifyMailEnabled (): boolean {
    const enabled = getEmail().enabled;
    if (enabled === false) return false;
    if (enabled != null && typeof enabled === 'object' && enabled.verifyEmail === false) return false;
    return true;
  }

  // Deliver one verification mail. The plaintext token is used only here, to
  // build the link and substitutions; it is never persisted (only its hash is).
  // The REQUIRED_WHEN boot check guarantees `auth.emailVerificationPageURL` is
  // populated when the verification mail is enabled.
  function deliverVerifyEmail (recipientEmail: string, username: string, lang: string, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const emailSettings = getEmail();
      const pageURL = getAuth().emailVerificationPageURL;
      const verifyLink = pageURL + '?verifyToken=' + encodeURIComponent(token);
      const recipient = { email: recipientEmail, name: username, type: 'to' };
      const substitutions = {
        VERIFY_TOKEN: token,
        VERIFY_URL: pageURL,
        VERIFY_LINK: verifyLink,
        EMAIL: recipientEmail,
        USERNAME: username
      };
      mailing.sendmail(emailSettings, emailSettings.verifyEmailTemplate, recipient, substitutions, lang,
        (err?: Error | null) => (err != null ? reject(err) : resolve()));
    });
  }

  api.register(
    'account.verifyEmail',
    commonFns.getParamsValidation(methodsSchema.verifyEmail.params),
    requireTrustedAppFn,
    addUserBusinessToContext,
    async function verifyEmailToken (context: MethodContext, params: { token: string }, result: ResultBag, next: Next) {
      try {
        // Invariant: addUserBusinessToContext ran earlier — userBusiness.id is
        // the path user's id. verifyToken is scoped to this user's own pending
        // events, so a token minted for another account cannot match here.
        const value = await emailsOperations.verifyToken(context.userBusiness!.id, params.token);
        if (value == null) {
          // One uniform failure for unknown / expired / already-verified — no
          // oracle on which case occurred.
          return next(errors.invalidAccessToken('The verification token is invalid or expired.'));
        }
        result.email = value;
        next();
      } catch (err) {
        return next(errors.unexpectedError(err));
      }
    },
    setAuditAccessId(AuditAccessIds.EMAIL_VERIFICATION_TOKEN)
  );

  // RESET PASSWORD

  api.register(
    'account.resetPassword',
    commonFns.getParamsValidation(methodsSchema.resetPassword.params),
    requireTrustedAppFn,
    checkResetToken,
    enforcePasswordRules,
    addUserBusinessToContext,
    setPassword,
    destroyPasswordResetToken,
    setAuditAccessId(AuditAccessIds.PASSWORD_RESET_TOKEN)
  );

  function checkResetToken (context: MethodContext, params: { resetToken: string }, _result: ResultBag, next: Next) {
    const username = context.user.username;
    if (username == null) {
      return next(new Error('AF: username is not empty.'));
    }
    passwordResetRequestsStorage.get(params.resetToken, username, function (err: Error | null, reqData: import('storages/interfaces/baseStorage/PasswordResetRequests.ts').PasswordResetDoc | null) {
      if (err) {
        return next(errors.unexpectedError(err));
      }
      if (!reqData) {
        return next(errors.invalidAccessToken('The reset token is invalid or expired'));
      }
      context.passwordResetRequest = reqData;
      next();
    });
  }

  async function updateDataOnPlatform (context: MethodContext, params: { update: Record<string, unknown> }, _result: ResultBag, next: Next) {
    if (Object.keys(params.update).length === 0) return next();
    try {
      const accountMap = accountStreams.accountMap;
      const operations: Array<Record<string, unknown>> = [];
      for (const [key, value] of Object.entries(params.update)) {
        // get previous value of the field;
        const previousValue = await usersRepository.getOnePropertyValue(context.user.id, key);
        // Stash the previous email so the container sync knows the old primary.
        if (key === 'email') { context.previousEmail = (previousValue as string | null) ?? null; }
        operations.push({
          action: 'update',
          key,
          value,
          previousValue,
          isUnique: accountMap[accountStreams.toStreamId(key)].isUnique,
          isActive: true
        });
      }
      await platform.updateUser(context.user.username, operations);
    } catch (err) {
      return next(err);
    }
    next();
  }

  async function updateAccount (context: MethodContext, params: { update: Record<string, unknown> }, _result: ResultBag, next: Next) {
    if (Object.keys(params.update).length === 0) return next();
    try {
      const accessId = context.access?.id
        ? context.access.id
        : UserRepositoryOptions.SYSTEM_USER_ACCESS_ID;
      await usersRepository.updateOne(context.user, params.update, accessId);
      pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_ACCOUNT_CHANGED);
    } catch (err) {
      return next(err);
    }
    next();
  }

  async function destroyPasswordResetToken (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    // Invariant: checkPasswordResetToken ran earlier in this chain.
    const id = context.passwordResetRequest!._id;
    await fromCallback((cb: (err?: unknown, result?: unknown) => void) => passwordResetRequestsStorage.destroy(id, context.user.username, cb));
    next();
  }

  // Build the user context the emails operations share. Reads the current
  // legacy primary from storage so seeding is reliable even for pre-seed users.
  async function emailsContext (context: MethodContext): Promise<EmailsUserContext> {
    const accessId = context.access?.id
      ? context.access.id
      : UserRepositoryOptions.SYSTEM_USER_ACCESS_ID;
    const legacyEmail = await usersRepository.getOnePropertyValue(context.user.id, 'email');
    return {
      userId: context.user.id as string,
      username: context.user.username as string,
      user: context.user,
      accessId,
      legacyEmail: (legacyEmail as string | null) ?? null
    };
  }

  // After the legacy email swap, mirror the change into the multi-email
  // container (promote/create the new primary, keep the old one as verified).
  async function syncLegacyEmailToContainer (context: MethodContext, params: { update: Record<string, unknown> }, _result: ResultBag, next: Next) {
    if (!Object.prototype.hasOwnProperty.call(params.update, 'email')) return next();
    try {
      const oldValue = context.previousEmail ?? null;
      const newValue = params.update.email as string;
      const ctx = await emailsContext(context);
      ctx.legacyEmail = oldValue; // seed from the pre-change primary if needed
      await emailsOperations.reconcileLegacyPrimaryChange(
        { errors, usersRepository }, ctx, oldValue, newValue);
    } catch (err) {
      return next(err);
    }
    next();
  }

  // Apply the `emails` operations object, in the order add, setPrimary, remove,
  // resend. add and resend each mint a token and send a verification mail; a
  // send failure on ADD is logged but not fatal (the row/event are committed;
  // resend recovers), while a resend send failure surfaces (the user asked for
  // it). The plaintext tokens never leave this method.
  async function applyEmailsOperations (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    const ops = context.emailsOperations;
    if (ops == null) return next();
    try {
      const ctx = await emailsContext(context);
      const deps = { errors, usersRepository };
      if (Array.isArray(ops.add) && ops.add.length > 0) {
        const minted = await emailsOperations.addEmails(deps, ctx, ops.add);
        await sendVerificationMails(context, minted, false);
      }
      if (ops.setPrimary != null) {
        const changed = await emailsOperations.setPrimary(deps, ctx, ops.setPrimary);
        if (changed) {
          // Keep the loaded user coherent so the result reflects the new primary.
          (context.user as Record<string, unknown>).email = ops.setPrimary;
          pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_ACCOUNT_CHANGED);
        }
      }
      if (Array.isArray(ops.remove) && ops.remove.length > 0) {
        await emailsOperations.removeEmails(deps, ctx, ops.remove);
      }
      if (Array.isArray(ops.resend) && ops.resend.length > 0) {
        const minted = [];
        for (const value of ops.resend) {
          minted.push(await emailsOperations.resendVerification(deps, ctx, value));
        }
        await sendVerificationMails(context, minted, true);
      }
    } catch (err) {
      return next(err);
    }
    next();
  }

  // Send verification mails for freshly minted { value, token } pairs. On the
  // ADD path (`fatal=false`) a delivery failure is logged and swallowed; on the
  // RESEND path (`fatal=true`) it is thrown so the caller sees it.
  async function sendVerificationMails (context: MethodContext, minted: Array<{ value: string; token: string }>, fatal: boolean): Promise<void> {
    if (minted.length === 0) return;
    if (!isVerifyMailEnabled()) return;
    const username = context.user.username as string;
    const lang = (await usersRepository.getOnePropertyValue(context.user.id, 'language')) as string | null;
    for (const { value, token } of minted) {
      // Persistent per-(account, address) throttle that survives remove/re-add,
      // so an add/remove/re-add loop cannot bomb an arbitrary inbox with
      // platform-branded mail. First send to an address always goes; a repeat
      // within the cooldown is skipped (add) or refused (resend).
      const allowed = await emailsOperations.reserveSendSlot(context.user.id, value);
      if (!allowed) {
        // A resend (fatal) surfaces the throttle; an add just skips silently.
        if (fatal) {
          throw errors.invalidOperation(
            'Please wait before requesting another verification email.', { email: value });
        }
        logger.info(`verification mail to ${value} throttled (recent send to this address)`);
        continue;
      }
      try {
        await deliverVerifyEmail(value, username, lang || getEmail().defaultLang || 'en', token);
      } catch (err) {
        // No mail went out: clear the per-event send timestamp AND release the
        // persistent throttle slot so the user can retry immediately (a real
        // delivery failure must not strand the address behind the cooldown).
        const ev = await emailsContainer.findRawByValue(context.user.id, value);
        if (ev != null) await emailsContainer.setContent(context.user.id, ev, { verificationSentAt: null });
        await emailsOperations.releaseSendSlot(context.user.id, value);
        if (fatal) throw err;
        // Do not leak the token: log the address and error message only.
        logger.warn(`verification mail to ${value} failed (add): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Build response body for the account update
   */
  async function buildResultData (context: MethodContext, params: { update: Record<string, unknown> }, result: ResultBag, next: Next) {
    Object.keys(params.update).forEach((key: string) => {
      (context.user as Record<string, unknown>)[key] = params.update[key];
    });
    // Invariant: addUserBusinessToContext ran earlier in this chain.
    const account = context.userBusiness!.getLegacyAccount() as Record<string, unknown>;
    try {
      account.emails = await emailsContainer.listViews(context.user.id, account.email as string | null);
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
    result.account = account;
    next();
  }
};
