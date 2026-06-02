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

type MulterReq = Record<string, unknown>;
type MulterFile = { fieldname?: string; originalname?: string; stream: NodeJS.ReadableStream; destination?: string; filename?: string; path?: string };
type FileInfo = { destination: string; filename: string; path: string; size: number; integrity: string };
type GetDestCb = (err: Error | null, destination?: string) => void;
type GetFilenameCb = (err: Error | null, filename?: string) => void;
type HandleCb = (err: Error | null, info?: FileInfo) => void;
type StorageOpts = {
  filename?: (req: MulterReq, file: MulterFile, cb: GetFilenameCb) => void;
  destination?: string | ((req: MulterReq, file: MulterFile, cb: GetDestCb) => void);
};

function getFilename (_req: MulterReq, _file: MulterFile, cb: GetFilenameCb) {
  crypto.randomBytes(16, function (err: Error | null, raw: Buffer) {
    cb(err, err ? undefined : raw.toString('hex'));
  });
}

function getDestination (_req: MulterReq, _file: MulterFile, cb: GetDestCb) {
  cb(null, os.tmpdir());
}

/**
 * @function IntegrityMulterDiskStorage - Returns a StorageEngine implementation configured to store files on the local file system and computes a hash.
 */
function MulterIntegrityDiskStorage (this: MulterIntegrityDiskStorageInstance, opts: StorageOpts) {
  this.getFilename = (opts.filename || getFilename);

  if (typeof opts.destination === 'string') {
    const dest = opts.destination;
    fs.mkdirSync(dest, { recursive: true });
    this.getDestination = function (_$0: MulterReq, _$1: MulterFile, cb: GetDestCb) { cb(null, dest); };
  } else {
    this.getDestination = (opts.destination || getDestination);
  }
}

type MulterIntegrityDiskStorageInstance = {
  getFilename: (req: MulterReq, file: MulterFile, cb: GetFilenameCb) => void;
  getDestination: (req: MulterReq, file: MulterFile, cb: GetDestCb) => void;
};

MulterIntegrityDiskStorage.prototype._handleFile = function _handleFile (this: MulterIntegrityDiskStorageInstance, req: MulterReq, file: MulterFile, cb: HandleCb) {
  const that = this;

  that.getDestination(req, file, function (err: Error | null, destination?: string) {
    if (err) return cb(err);

    that.getFilename(req, file, function (err: Error | null, filename?: string) {
      if (err) return cb(err);

      const finalPath = path.join(destination!, filename!);
      const outStream = fs.createWriteStream(finalPath);
      const integrityStream = new IntegrityStream('sha256');

      (file.stream as unknown as { pipe: (s: unknown) => { pipe: (s: unknown) => unknown } }).pipe(integrityStream).pipe(outStream);
      outStream.on('error', cb);
      outStream.on('finish', function () {
        cb(null, {
          destination: destination!,
          filename: filename!,
          path: finalPath,
          size: outStream.bytesWritten,
          integrity: integrityStream.getDigest()
        });
      });
    });
  });
};

MulterIntegrityDiskStorage.prototype._removeFile = function _removeFile (_req: MulterReq, file: MulterFile, cb: (err: Error | null) => void) {
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
export default function (opts: StorageOpts) {
  return new (MulterIntegrityDiskStorage as unknown as new (opts: StorageOpts) => MulterIntegrityDiskStorageInstance)(opts);
}

// -- CHECKSUM STREAM

const PassThrough = require('stream').PassThrough;

class IntegrityStream extends PassThrough {
  checksum: ReturnType<typeof crypto.createHash>;
  digest: string | null = null;
  hashOptionsAlgorythm: string;

  constructor (hashOptionsAlgorythm: string, hashOptions?: Parameters<typeof crypto.createHash>[1]) {
    super();
    this.hashOptionsAlgorythm = hashOptionsAlgorythm;
    this.checksum = crypto.createHash(hashOptionsAlgorythm, hashOptions);
    this.on('finish', () => {
      this.digest = this.checksum.digest('base64');
    });
  }

  _transform (chunk: Buffer, _encoding: BufferEncoding, done: (err?: Error | null) => void) {
    try {
      this.checksum.update(chunk);
      this.push(chunk);
      done();
    } catch (e) {
      done(e as Error);
    }
  }

  getDigest () {
    if (this.digest == null) throw new Error('Failed computing checksum on event');
    return this.hashOptionsAlgorythm + '-' + this.digest;
  }
}
