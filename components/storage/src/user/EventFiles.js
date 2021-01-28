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
var async = require('async'),
    generateId = require('cuid'),
    fs = require('fs'),
    mkdirp = require('mkdirp'),
    path = require('path'),
    rimraf = require('rimraf'),
    toString = require('utils').toString;

module.exports = EventFiles;
/**
 * Manages files storage for events (attachments & previews).
 *
 */
function EventFiles(settings, logger) {
  this.settings = settings;
  this.logger = logger; 
}

/**
 * Computes the total storage size of the given user's attached files, in bytes.
 *
 * @param {Object} user
 * @param {Function} callback
 */
EventFiles.prototype.getTotalSize = function (user, callback) {
  var userPath = this.getAttachmentPath(user.id);
  fs.exists(userPath, function (exists) {
    if (! exists) {
      this.logger.debug('No attachments dir for user ' + toString.user(user));
      return callback(null, 0);
    }
    getSizeRecursive.call(this, userPath, callback);
  }.bind(this));
};

/**
 * Gets all files sizes assyncronously using generators
 */
async function* recursiveReadDirAsync(dir) {
  const dirents = await fs.promises.readdir(dir, {withFileTypes: true});
  for (const dirent of dirents) {
    const res = path.resolve(dir, dirent.name);
    if (dirent.isDirectory()) {
      yield * recursiveReadDirAsync(res);
    } else {
      try{
        const fileStats = await fs.promises.stat(res);
        yield fileStats.size;
      } catch(err){
        this.logger.error('Data corrupted; expected ' + toString.path(filePath) + ' to exist');
        yield 0;
      }      
    }
  }
}

/**
 * @param filePath
 * @param callback
 * @this {EventFiles}
 */
function getSizeRecursive(filePath, callback) {

  (async () => {
    let total = 0;
    for await (const f of recursiveReadDirAsync(filePath)) {
      total += f;
    }
    callback(null, total);
  })()
}

/**
 * Generates a new id for the given file.
 *
 * @param {String} filePath
 * @returns {String}
 */
EventFiles.prototype.generateFileId = function (filePath) {
  filePath;
  
  // for now we just generate a random id (in the future we could do a SHA digest)
  return generateId();
};

/**
 * @param tempPath The current, temporary path of the file to save (the file will actually be moved
 *                 from that path)
 */
EventFiles.prototype.saveAttachedFile = function (tempPath, user, eventId, fileId, callback) {
  if (typeof(fileId) === 'function') {
    // no fileId provided
    callback = fileId;
    fileId = this.generateFileId(tempPath);
  }
  var dirPath = this.getAttachmentPath(user.id, eventId);
  mkdirp(dirPath).then(function (res, err) {
    if (err) { return callback(err); }

    var readStream = fs.createReadStream(tempPath);
    var writeStream = fs.createWriteStream(path.join(dirPath, fileId));

    readStream.on('error', callback);
    writeStream.on('error', callback);
    writeStream.on('close', function () {
      fs.unlink(tempPath, function (err) {
        if (err) { return callback(err); }
        callback(null, fileId);
      });
    });

    readStream.pipe(writeStream);
  });
};

EventFiles.prototype.removeAttachedFile = function (user, eventId, fileId, callback) {
  var filePath = this.getAttachmentPath(user.id, eventId, fileId);
  fs.unlink(filePath, function (err) {
    if (err) { return callback(err); }
    this.cleanupStructure(path.dirname(filePath), callback);
  }.bind(this));
};

EventFiles.prototype.removeAllForEvent = function (user, eventId, callback) {
  var dirPath = this.getAttachmentPath(user.id, eventId);
  rimraf(dirPath, function (err) {
    if (err) { return callback(err); }
    this.cleanupStructure(path.dirname(dirPath), callback);
  }.bind(this));
};

EventFiles.prototype.removeAllForUser = function (user, callback) {
  rimraf(this.getAttachmentPath(user.id), callback);
};

/**
 * Primarily meant for tests.
 *
 * @param callback
 */
EventFiles.prototype.removeAll = function (callback) {
  rimraf(this.settings.attachmentsDirPath, callback);
};

/**
 * @param {Object} user
 * @param {String} eventId
 * @param {String} fileId Optional
 * @returns {String}
 */
EventFiles.prototype.getAttachedFilePath = function (user /*, eventId, fileId*/) {
  var args = [].slice.call(arguments);
  args[0] = user.id;
  return this.getAttachmentPath.apply(this, args);
};

/**
 * @private
 */
EventFiles.prototype.getAttachmentPath = function (/*userId, eventId, fileId*/) {
  var args = [].slice.call(arguments);
  args.unshift(this.settings.attachmentsDirPath);
  return path.join.apply(null, args);
};

/**
 * Ensures the preview path for the specific event exists.
 * Only support JPEG preview images (fixed size) at the moment.
 *
 * @param {Object} user
 * @param {String} eventId
 * @param {Number} dimension
 * @param {Function} callback (error, previewPath)
 */
EventFiles.prototype.ensurePreviewPath = function (user, eventId, dimension, callback) {
  var dirPath = path.join(this.settings.previewsDirPath, user.id, eventId);
  mkdirp(dirPath).then(function (res, err) {
    if (err) { return callback(err); }
    callback(null, path.join(dirPath, getPreviewFileName(dimension)));
  });
};

/**
 * @param {Object} user
 * @param {String} eventId
 * @param {Number} dimension
 * @returns {String}
 */
EventFiles.prototype.getPreviewFilePath = function (user, eventId, dimension) {
  return path.join(this.settings.previewsDirPath, user.id, eventId, getPreviewFileName(dimension));
};

function getPreviewFileName(dimension) {
  return dimension + '.jpg';
}

/**
 * Attempts to remove the given directory and its parents (if empty) until the root attachments
 * directory is reached.
 *
 * @private
 */
EventFiles.prototype.cleanupStructure = function cleanupStructure(dirPath, callback) {
  if (dirPath === this.settings.attachmentsDirPath) {
    return callback();
  }

  fs.rmdir(dirPath, function (err) {
    if (err) {
      // assume the dir is not empty
      return callback();
    }
    cleanupStructure.call(this, path.dirname(dirPath), callback);
  }.bind(this));
};
