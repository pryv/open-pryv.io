/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const timestamp = require('unix-timestamp');
const { getConfig } = require('@pryv/boiler');

const errors = require('errors').factory;

type UserAccountStorageLike = {
  getCurrentPasswordTime (userId: string): Promise<number>;
  passwordExistsInHistory (userId: string, password: string, historyLength: number): Promise<boolean>;
};
type AuthSettings = {
  passwordAgeMaxDays?: number;
  passwordAgeMinDays?: number;
  passwordComplexityMinLength?: number;
  passwordComplexityMinCharCategories?: number;
  passwordPreventReuseHistoryLength?: number;
  [k: string]: unknown;
};
type PasswordRules = {
  getPasswordExpirationAndChangeTimes (userId: string): Promise<{ passwordExpires?: number; passwordCanBeChanged?: number }>;
  checkCurrentPasswordAge (userId: string): Promise<void>;
  checkNewPassword (userId: string | null, password: string): Promise<void>;
};

let singleton: PasswordRules | null = null;
let userAccountStorage: UserAccountStorageLike | null = null;

/**
 * Return the password rules singleton, initializing it with the given settings if needed.
 */
async function get (): Promise<PasswordRules> {
  if (!singleton) {
    singleton = await init();
  }
  return singleton;
}
export default get;

async function init (): Promise<PasswordRules> {
  const { getUserAccountStorage } = require('storage');
  userAccountStorage = await getUserAccountStorage() as UserAccountStorageLike;
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
     * @throws {APIError} If the password does not follow the configured rules
     */
    async checkCurrentPasswordAge (userId: string) {
      await checkMinimumAge(userId);
    },
    /**
     * @param userId Optional; if set, will check the user's password history
     * @throws {APIError} If the password does not follow the configured rules
     */
    async checkNewPassword (userId: string | null, password: string) {
      checkLength(password);
      checkCharCategories(password);
      if (userId) {
        await checkHistory(userId, password);
      }
    }
  };

  async function getPasswordExpirationAndChangeTimes (userId: string): Promise<{ passwordExpires?: number; passwordCanBeChanged?: number }> {
    const maxDays = settings().passwordAgeMaxDays!;
    const minDays = settings().passwordAgeMinDays!;
    const pwdTime = await userAccountStorage!.getCurrentPasswordTime(userId);
    const res: { passwordExpires?: number; passwordCanBeChanged?: number } = {};
    if (maxDays !== 0) {
      res.passwordExpires = timestamp.add(pwdTime, `${maxDays}d`);
    }
    if (minDays !== 0) {
      res.passwordCanBeChanged = timestamp.add(pwdTime, `${minDays}d`);
    }
    return res;
  }

  async function checkMinimumAge (userId: string) {
    const minDays = settings().passwordAgeMinDays!;
    if (minDays === 0) {
      return;
    }
    const pwdTime = await userAccountStorage!.getCurrentPasswordTime(userId);
    if (timestamp.now(`-${minDays}d`) < pwdTime) {
      const msg = `The current password was set less than ${minDays} day(s) ago`;
      throw errors.invalidOperation(`The password cannot be changed yet (age rules): ${msg}`);
    }
  }

  function checkLength (password: string) {
    const minLength = settings().passwordComplexityMinLength!;
    if (minLength === 0) {
      return;
    }
    const length = password.length;
    if (length < minLength) {
      const msg = `Password is ${length} characters long, but at least ${minLength} are required`;
      throw errors.invalidParametersFormat(`The new password does not follow complexity rules: ${msg}`, [msg]);
    }
  }

  function checkCharCategories (password: string) {
    const requiredCharCats = settings().passwordComplexityMinCharCategories!;
    if (requiredCharCats === 0) {
      return;
    }
    const count = countCharCategories(password);
    if (count < requiredCharCats) {
      const msg = `Password contains characters from ${count} categories, but at least ${requiredCharCats} are required`;
      throw errors.invalidParametersFormat(`The new password does not follow complexity rules: ${msg}`, [msg]);
    }
  }

  function countCharCategories (password: string): number {
    return Object.values(charCategoriesRegExps).reduce(
      (count, regExp) => regExp.test(password) ? count + 1 : count,
      0
    );
  }

  async function checkHistory (userId: string, password: string) {
    const historyLength = settings().passwordPreventReuseHistoryLength!;
    if (historyLength === 0) {
      return;
    }
    if (await userAccountStorage!.passwordExistsInHistory(userId, password, historyLength)) {
      const msg = `Password was found in the ${historyLength} last used passwords, which is forbidden`;
      throw errors.invalidOperation(`The new password does not follow reuse rules: ${msg}`);
    }
  }

  // The `settings().passwordX!` uses above rely on default-config.yml always
  // providing the auth.password* keys (config defaults, not runtime checks).
  function settings (): AuthSettings {
    return config.get('auth') as AuthSettings;
  }
}
