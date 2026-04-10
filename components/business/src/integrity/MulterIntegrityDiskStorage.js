/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * Inspired from multer/storage/DiskStorage
 * Add an integrity field to file upload following the subresource integrity schema
 *  <algo>-<base64 digest>
 * https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const mkdirp = require('mkdirp');

function getFilename (req, file, cb) {
  crypto.randomBytes(16, function (err, raw) {
    cb(err, err ? undefined : raw.toString('hex'));
  });
}

function getDestination (req, file, cb) {
  cb(null, os.tmpdir());
}

/**
 * @function IntegrityMulterDiskStorage - Returns a StorageEngine implementation configured to store files on the local file system and computes a hash.
 * @param {*} opts
 */
function MulterIntegrityDiskStorage (opts) {
  this.getFilename = (opts.filename || getFilename);

  if (typeof opts.destination === 'string') {
    mkdirp.sync(opts.destination);
    this.getDestination = function ($0, $1, cb) { cb(null, opts.destination); };
  } else {
    this.getDestination = (opts.destination || getDestination);
  }
}

MulterIntegrityDiskStorage.prototype._handleFile = function _handleFile (req, file, cb) {
  const that = this;

  that.getDestination(req, file, function (err, destination) {
    if (err) return cb(err);

    that.getFilename(req, file, function (err, filename) {
      if (err) return cb(err);

      const finalPath = path.join(destination, filename);
      const outStream = fs.createWriteStream(finalPath);
      const integrityStream = new IntegrityStream('sha256');

      file.stream.pipe(integrityStream).pipe(outStream);
      outStream.on('error', cb);
      outStream.on('finish', function () {
        cb(null, {
          destination,
          filename,
          path: finalPath,
          size: outStream.bytesWritten,
          integrity: integrityStream.getDigest()
        });
      });
    });
  });
};

MulterIntegrityDiskStorage.prototype._removeFile = function _removeFile (req, file, cb) {
  const path = file.path;

  delete file.destination;
  delete file.filename;
  delete file.path;

  fs.unlink(path, cb);
};

/**
 * Multer disk storage
 * @module IntegrityMulterIntegrityDiskStorage
 */
module.exports = function (opts) {
  return new MulterIntegrityDiskStorage(opts);
};

// -- CHECKSUM STREAM

const PassThrough = require('stream').PassThrough;

class IntegrityStream extends PassThrough {
  checksum;
  digest;
  hashOptionsAlgorythm;

  constructor (hashOptionsAlgorythm, hashOptions) {
    super();
    this.hashOptionsAlgorythm = hashOptionsAlgorythm;
    this.checksum = crypto.createHash(hashOptionsAlgorythm, hashOptions);
    this.on('finish', () => {
      this.digest = this.checksum.digest('base64');
    });
  }

  _transform (chunk, encoding, done) {
    try {
      this.checksum.update(chunk);
      this.push(chunk);
      done();
    } catch (e) {
      done(e);
    }
  }

  getDigest () {
    if (this.digest == null) throw new Error('Failed computing checksum on event');
    return this.hashOptionsAlgorythm + '-' + this.digest;
  }
}
