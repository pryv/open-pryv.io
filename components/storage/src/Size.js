/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const { getUsersRepository, UserRepositoryOptions, User } = require('business/src/users');
const { getMall } = require('mall');

class Size {
  /**
   * Computes and updates storage size for the given user.
   *
   * @param {Object} user
   */
  async computeForUser (user) {
    const mall = await getMall();
    const storageInfo = await mall.getUserStorageInfos(user.id);
    let dbDocuments = 0;
    let attachedFiles = 0;
    for (const entry of Object.entries(storageInfo)) {
      if (entry.streams?.count) dbDocuments += entry.streams?.count;
      if (entry.events?.count) dbDocuments += entry.events?.count;
      if (entry.files?.sizeKb) attachedFiles += entry.files?.sizeKb;
    }
    // reconstruct previous system
    const storageUsed = {
      dbDocuments,
      attachedFiles
    };
    const userObject = new User(user);
    const usersRepository = await getUsersRepository();
    await usersRepository.updateOne(
      userObject,
      storageUsed,
      UserRepositoryOptions.SYSTEM_USER_ACCESS_ID
    );

    return storageInfo;
  }
}
module.exports = Size;
