var errors = require('components/errors').factory,
    commonFns = require('./helpers/commonFunctions'),
    mailing = require('./helpers/mailing'),
    encryption = require('components/utils').encryption,
    methodsSchema = require('../schema/accountMethods'),
    request = require('superagent');

/**
 * @param api
 * @param usersStorage
 * @param passwordResetRequestsStorage
 * @param authSettings
 * @param servicesSettings Must contain `email` and `register`
 * @param notifications
 */
module.exports = function (api, usersStorage, passwordResetRequestsStorage,
  authSettings, servicesSettings, notifications) {

  var registerSettings = servicesSettings.register,
      emailSettings = servicesSettings.email,
      requireTrustedAppFn =  commonFns.getTrustedAppCheck(authSettings);

  // RETRIEVAL

  api.register('account.get',
    commonFns.requirePersonalAccess,
    commonFns.getParamsValidation(methodsSchema.get.params),
    function (context, params, result, next) {
      usersStorage.findOne({id: context.user.id}, null, function (err, user) {
        if (err) { return next(errors.unexpectedError(err)); }

        sanitizeAccountDetails(user);
        result.account = user;
        next();
      });
    });

  // UPDATE

  api.register('account.update',
    commonFns.requirePersonalAccess,
    commonFns.getParamsValidation(methodsSchema.update.params),
    notifyEmailChangeToRegister,
    updateAccount);

  // CHANGE PASSWORD

  api.register('account.changePassword',
    commonFns.requirePersonalAccess,
    commonFns.getParamsValidation(methodsSchema.changePassword.params),
    verifyOldPassword,
    encryptNewPassword,
    updateAccount,
    cleanupResult);

  function verifyOldPassword(context, params, result, next) {
    encryption.compare(params.oldPassword, context.user.passwordHash, function (err, isValid) {
      if (err) { return next(errors.unexpectedError(err)); }

      if (! isValid) {
        return next(errors.invalidOperation(
          'The given password does not match.'));
      }
      next();
    });
  }

  // REQUEST PASSWORD RESET

  api.register('account.requestPasswordReset',
    commonFns.getParamsValidation(methodsSchema.requestPasswordReset.params),
    requireTrustedAppFn,
    generatePasswordResetRequest,
    sendPasswordResetMail);

  function generatePasswordResetRequest(context, params, result, next) {
    const username = context.user.username;
    if (username == null) {
      return next(new Error('AF: username is not empty.'));
    }
    passwordResetRequestsStorage.generate(username, function (err, token) {
      if (err) { return next(errors.unexpectedError(err)); }

      context.resetToken = token;
      next();
    });
  }

  function sendPasswordResetMail(context, params, result, next) {
    // Skip this step if reset mail is deactivated
    const isMailActivated = emailSettings.enabled;
    if (isMailActivated === false ||
       (isMailActivated != null && isMailActivated.resetPassword === false)) {
      return next();
    }
    
    const recipient = {
      email: context.user.email,
      name: context.user.username,
      type: 'to'
    };
    
    const substitutions = {
      RESET_TOKEN: context.resetToken,
      RESET_URL: authSettings.passwordResetPageURL
    };

    mailing.sendmail(emailSettings, emailSettings.resetPasswordTemplate,
      recipient, substitutions, context.user.language, next);
  }

  // RESET PASSWORD

  api.register('account.resetPassword',
    commonFns.getParamsValidation(methodsSchema.resetPassword.params),
    requireTrustedAppFn,
    checkResetToken,
    encryptNewPassword,
    updateAccount,
    cleanupResult);

  function checkResetToken(context, params, result, next) {
    const username = context.user.username;
    if (username == null) {
      return next(new Error('AF: username is not empty.'));
    }
    passwordResetRequestsStorage.get(
      params.resetToken,
      username,
      function (err, reqData) {
        if (err) { return next(errors.unexpectedError(err)); }

        if (! reqData) {
          return next(errors.invalidAccessToken('The reset token is invalid or expired'));
        }
        next();
      }
    );
  }

  function encryptNewPassword(context, params, result, next) {
    if (! params.newPassword) { return next(); }

    encryption.hash(params.newPassword, function (err, hash) {
      if (err) { return next(errors.unexpectedError(err)); }

      params.update = {passwordHash: hash};
      next();
    });
  }

  function notifyEmailChangeToRegister(context, params, result, next) {
    const currentEmail = context.user.email;
    const newEmail = params.update.email;

    if (newEmail == null || newEmail === currentEmail) {
      return next();
    }
    // email was changed, must notify registration server
    const regChangeEmailURL = registerSettings.url + '/users/' + context.user.username +
        '/change-email';
    request.post(regChangeEmailURL)
      .set('Authorization', registerSettings.key)
      .send({email: newEmail})
      .end(function (err, res) {

        if (err != null || (res && ! res.ok)) {
          let errMsg = 'Failed to update email on register. ';
          // for some reason register returns error message within res.body
          if (res != null && res.body != null && res.body.message != null) {
            errMsg += res.body.message;
          } else if (err != null && err.message != null) {
            errMsg += err.message;
          }
          return next(errors.invalidOperation(errMsg, {email: newEmail}, err));
        }

        next();
      });
  }

  function updateAccount(context, params, result, next) {
    usersStorage.updateOne({id: context.user.id}, params.update, function (err, updatedUser) {
      if (err) { return next(errors.unexpectedError(err)); }

      sanitizeAccountDetails(updatedUser);
      result.account = updatedUser;
      notifications.accountChanged(context.user);
      next();
    });
  }

  function cleanupResult(context, params, result, next) {
    delete result.account;
    next();
  }

  function sanitizeAccountDetails(data) {
    delete data.id;
    delete data.passwordHash;
    if (! data.storageUsed) {
      data.storageUsed = {
        dbDocuments: -1,
        attachedFiles: -1
      };
    }
  }

};
module.exports.injectDependencies = true;
