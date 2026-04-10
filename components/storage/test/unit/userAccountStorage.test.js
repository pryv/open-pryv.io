/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const { userLocalDirectory, getUserAccountStorage } = require('storage');
const conformanceTests = require('storages/interfaces/baseStorage/conformance/UserAccountStorage.test');

describe('[UAST] Users Account Storage', () => {
  conformanceTests(
    async () => {
      await userLocalDirectory.init();
      return await getUserAccountStorage();
    },
    async (userId) => {
      await userLocalDirectory.deleteUserDirectory(userId);
    }
  );
});
