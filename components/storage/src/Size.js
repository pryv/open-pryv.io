/**
 * @license
 * Copyright (c) 2020 Pryv S.A. https://pryv.com
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
 * 
 */
var async = require('async');

module.exports = Size;

/**
 * Computes storage size used by user accounts.
 * Will sum sizes returned by `getTotalSize(user, callback)` on the given storage objects,
 * if function is present.
 *
 * @param {Array} dbDocumentsItems
 * @param {Array} attachedFilesItems
 * @constructor
 */
function Size(usersStorage, dbDocumentsItems, attachedFilesItems) {
  this.usersStorage = usersStorage;
  this.dbDocumentsItems = dbDocumentsItems;
  this.attachedFilesItems = attachedFilesItems;
}

/**
 * Computes and updates storage size for the given user.
 *
 * @param {Object} user
 * @param {Function} callback
 */
Size.prototype.computeForUser = function (user, callback) {
  async.series({
    dbDocuments: computeCategory.bind(this, this.dbDocumentsItems),
    attachedFiles: computeCategory.bind(this, this.attachedFilesItems)
  }, function (err, storageUsed) {
    if (err) { return callback(err); }
    this.usersStorage.updateOne({id: user.id}, {storageUsed: storageUsed}, function (err) {
      if (err) { return callback(err); }
      callback(null, storageUsed);
    });
  }.bind(this));

  function computeCategory(storageItems, callback) {
    var total = 0;
    async.each(storageItems, function (storage, itemDone) {
      if (typeof storage.getTotalSize !== 'function') { return; }

      storage.getTotalSize(user, function (err, size) {
        if (err) { return itemDone(err); }
        total += size;
        itemDone();
      });
    }.bind(this), function (err) {
      callback(err, total);
    });
  }
};
