/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const timestamp = require('unix-timestamp');
const { getConfig } = require('@pryv/boiler');

const errors = require('errors').factory;

let singleton = null;
let userAccountStorage = null;

/**
 * Return the password rules singleton, initializing it with the given settings if needed.
 */
module.exports = async function get () {
  if (!singleton) {
    singleton = init();
  }
  return singleton;
};

async function init () {
  const { getUserAccountStorage } = require('storage');
  userAccountStorage = await getUserAccountStorage();
  const config = await getConfig();
  const charCategoriesRegExps = {
    lowercase: /[a-z]/,
    uppercase: /[A-Z]/,
    numberRegEx: /[0-9]/,
    specialChar: /[^a-zA-Z0-9]/
  };

  return {
    getPasswordExpirationAndChangeTimes,
    /**
     * TODO: merge with verification of current password once passwords are entirely within user account storage
     * @param {String} userId
     * @throws {APIError} If the password does not follow the configured rules
     */
    async checkCurrentPasswordAge (userId) {
      await checkMinimumAge(userId);
    },
    /**
     * @param {String} userId Optional; if set, will check the user's password history
     * @param {String} password
     * @throws {APIError} If the password does not follow the configured rules
     */
    async checkNewPassword (userId, password) {
      checkLength(password);
      checkCharCategories(password);
      if (userId) {
        await checkHistory(userId, password);
      }
    }
  };

  /**
   * @param {String} userId
   * @returns {Object} times
   * @returns {number} times.passwordExpires `undefined` if "max age" setting is disabled
   * @returns {number} times.passwordCanBeChanged `undefined` if "min age" setting is disabled
   */
  async function getPasswordExpirationAndChangeTimes (userId) {
    const maxDays = settings().passwordAgeMaxDays;
    const minDays = settings().passwordAgeMinDays;
    const pwdTime = await userAccountStorage.getCurrentPasswordTime(userId);
    const res = {};
    if (maxDays !== 0) {
      res.passwordExpires = timestamp.add(pwdTime, `${maxDays}d`);
    }
    if (minDays !== 0) {
      res.passwordCanBeChanged = timestamp.add(pwdTime, `${minDays}d`);
    }
    return res;
  }

  async function checkMinimumAge (userId) {
    const minDays = settings().passwordAgeMinDays;
    if (minDays === 0) {
      return;
    }
    const pwdTime = await userAccountStorage.getCurrentPasswordTime(userId);
    if (timestamp.now(`-${minDays}d`) < pwdTime) {
      const msg = `The current password was set less than ${minDays} day(s) ago`;
      throw errors.invalidOperation(`The password cannot be changed yet (age rules): ${msg}`);
    }
  }

  function checkLength (password) {
    const minLength = settings().passwordComplexityMinLength;
    if (minLength === 0) {
      return;
    }
    const length = password.length;
    if (length < minLength) {
      const msg = `Password is ${length} characters long, but at least ${minLength} are required`;
      throw errors.invalidParametersFormat(`The new password does not follow complexity rules: ${msg}`, [msg]);
    }
  }

  function checkCharCategories (password) {
    const requiredCharCats = settings().passwordComplexityMinCharCategories;
    if (requiredCharCats === 0) {
      return;
    }
    const count = countCharCategories(password);
    if (count < requiredCharCats) {
      const msg = `Password contains characters from ${count} categories, but at least ${requiredCharCats} are required`;
      throw errors.invalidParametersFormat(`The new password does not follow complexity rules: ${msg}`, [msg]);
    }
  }

  function countCharCategories (password) {
    return Object.values(charCategoriesRegExps).reduce(
      (count, regExp) => regExp.test(password) ? count + 1 : count,
      0
    );
  }

  async function checkHistory (userId, password) {
    const historyLength = settings().passwordPreventReuseHistoryLength;
    if (historyLength === 0) {
      return;
    }
    if (await userAccountStorage.passwordExistsInHistory(userId, password, settings().passwordPreventReuseHistoryLength)) {
      const msg = `Password was found in the ${settings().passwordPreventReuseHistoryLength} last used passwords, which is forbidden`;
      throw errors.invalidOperation(`The new password does not follow reuse rules: ${msg}`);
    }
  }

  function settings () {
    return config.get('auth');
  }
}
