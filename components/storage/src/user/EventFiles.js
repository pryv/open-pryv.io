var async = require('async'),
    generateId = require('cuid'),
    fs = require('fs'),
    mkdirp = require('mkdirp'),
    path = require('path'),
    rimraf = require('rimraf'),
    toString = require('components/utils').toString;

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
 * @param filePath
 * @param callback
 * @this {EventFiles}
 */
function getSizeRecursive(filePath, callback) {
  fs.lstat(filePath, function (err, stats) {
    if (err) {
      this.logger.error('Data corrupted; expected ' + toString.path(filePath) + ' to exist');
      return callback(null, 0);
    }

    var total = stats.size;

    if (stats.isDirectory()) {
      fs.readdir(filePath, function (err, fileNames) {
        if (err) { return callback(err); }

        async.forEach(fileNames, function (fileName, fileDone) {
          getSizeRecursive.call(this, path.join(filePath, fileName), function (err, fileSize) {
            if (! err) {
              total += fileSize;
            }
            fileDone(err);
          });
        }, function (err) {
          callback(err, total);
        });
      }.bind(this));
    } else {
      callback(null, total);
    }
  }.bind(this));
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
