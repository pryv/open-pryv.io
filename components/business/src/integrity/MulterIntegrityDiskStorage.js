/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
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
