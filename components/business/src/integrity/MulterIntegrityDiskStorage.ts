/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
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

function getFilename (req: any, file: any, cb: any) {
  crypto.randomBytes(16, function (err: any, raw: any) {
    cb(err, err ? undefined : raw.toString('hex'));
  });
}

function getDestination (req: any, file: any, cb: any) {
  cb(null, os.tmpdir());
}

/**
 * @function IntegrityMulterDiskStorage - Returns a StorageEngine implementation configured to store files on the local file system and computes a hash.
 */
function MulterIntegrityDiskStorage (this: any, opts: any) {
  this.getFilename = (opts.filename || getFilename);

  if (typeof opts.destination === 'string') {
    fs.mkdirSync(opts.destination, { recursive: true });
    this.getDestination = function ($0: any, $1: any, cb: any) { cb(null, opts.destination); };
  } else {
    this.getDestination = (opts.destination || getDestination);
  }
}

MulterIntegrityDiskStorage.prototype._handleFile = function _handleFile (req: any, file: any, cb: any) {
  const that = this;

  that.getDestination(req, file, function (err: any, destination: any) {
    if (err) return cb(err);

    that.getFilename(req, file, function (err: any, filename: any) {
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

MulterIntegrityDiskStorage.prototype._removeFile = function _removeFile (req: any, file: any, cb: any) {
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
export default function (opts: any) {
  return new (MulterIntegrityDiskStorage as any)(opts);
}

// -- CHECKSUM STREAM

const PassThrough = require('stream').PassThrough;

class IntegrityStream extends PassThrough {
  checksum: any;
  digest: any;
  hashOptionsAlgorythm: any;

  constructor (hashOptionsAlgorythm: any, hashOptions?: any) {
    super();
    this.hashOptionsAlgorythm = hashOptionsAlgorythm;
    this.checksum = crypto.createHash(hashOptionsAlgorythm, hashOptions);
    this.on('finish', () => {
      this.digest = this.checksum.digest('base64');
    });
  }

  _transform (chunk: any, encoding: any, done: any) {
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
