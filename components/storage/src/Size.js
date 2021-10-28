/**
 * @license
 * Copyright (C) 2020-2021 Pryv S.A. https://pryv.com 
 * 
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 * 
 * Redistribution and use in source and binary forms, with or without 
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, 
 *    this list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice, 
 *    this list of conditions and the following disclaimer in the documentation 
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its contributors 
 *    may be used to endorse or promote products derived from this software 
 *    without specific prior written permission.
 * 
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" 
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE 
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE 
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE 
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL 
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR 
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER 
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, 
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE 
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 * 
 * SPDX-License-Identifier: BSD-3-Clause
 */
const bluebird = require('bluebird');

const { getUsersRepository, UserRepositoryOptions, User } = require('business/src/users');

class Size {

  userEventsStorage;
  dbDocumentsItems;
  attachedFilesItems;

  /**
 * Computes storage size used by user accounts.
 * Will sum sizes returned by `getTotalSize(user, callback)` on the given storage objects,
 * if function is present.
 *
 * @param {Array} dbDocumentsItems
 * @param {Array} attachedFilesItems
 * @constructor
 */
  constructor(userEventsStorage, dbDocumentsItems, attachedFilesItems) {
    this.userEventsStorage = userEventsStorage;
    this.dbDocumentsItems = dbDocumentsItems;
    this.attachedFilesItems = attachedFilesItems;
  }
  
  /**
   * Computes and updates storage size for the given user.
   *
   * @param {Object} user
   */
  async computeForUser(user) {
    const storageUsed = {
      dbDocuments: await computeCategory(this.dbDocumentsItems),
      attachedFiles: await computeCategory(this.attachedFilesItems),
    }
    let userObject = new User(user);
    const usersRepository = await getUsersRepository();
    await usersRepository.updateOne(
      userObject,
      storageUsed,
      UserRepositoryOptions.SYSTEM_USER_ACCESS_ID
    );

    return storageUsed;

    async function computeCategory(storageItems) {
      let total = 0;
      for (let i=0; i<storageItems.length; i++) {
        if (typeof storageItems[i].getTotalSize !== 'function') { return; }
        const size = await bluebird.fromCallback(cb => storageItems[i].getTotalSize(user, cb));
        total += size;
      }
      return total;
    }
  }
}
module.exports = Size;