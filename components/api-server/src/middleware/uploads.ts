/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Request, Response, NextFunction } from 'express';
import { removeUploadedFile } from '../methods/helpers/uploadedFiles.ts';
const require = createRequire(import.meta.url);
'use strict';
// A middleware that allows checking uploads and that will at the same time
// allow uploads for the route.
const filesUploadSupport = require('middleware').filesUploadSupport;
const multer = require('multer');
const integrity = require('business').integrity;
const errorsFactory = require('errors').factory;
const { getConfigSync, getLogger } = require('@pryv/boiler');
// load the correct disk storage depending on settings
const MulterDiskStorage = integrity.attachments.isActive
  ? integrity.attachments.MulterIntegrityDiskStorage
  : multer.diskStorage;
// ---------------------------------------------------------------- multer setup
// Parse multipart file data into request.files:
const storage = MulterDiskStorage({
  filename: null,
  // The operating system's default directory for temporary files is used, with
  // a random 32-hex name per file. The events methods only open uploads found
  // there (methods/helpers/uploadedFiles.ts): keep both in sync.
  destination: null
});

interface MulterUploadFactory {
  any: () => (req: Request, res: Response, cb: (err: unknown) => void) => void;
}

/** Applied when `uploads.maxSizeMb` is absent or not a positive number. */
const DEFAULT_MAX_SIZE_MB = 50;
/** Applied when `uploads.maxFiles` is absent or not a positive integer. */
const DEFAULT_MAX_FILES = 10;

type UploadLimits = { fileSize: number, fieldSize: number, fields: number, files: number, parts: number };

/** The `uploads.maxSizeMb` setting when it is a positive number, the default otherwise. */
function effectiveMaxSizeMb (maxSizeMbSetting: unknown): number {
  const maxSizeMb = Number(maxSizeMbSetting);
  if (maxSizeMbSetting == null || !Number.isFinite(maxSizeMb) || maxSizeMb <= 0) return DEFAULT_MAX_SIZE_MB;
  return maxSizeMb;
}

/**
 * Multipart parser limits from the `uploads.maxSizeMb` and `uploads.maxFiles`
 * settings. A request carries at most one non-file part (the JSON body) and
 * `maxFiles` files; each file, and the JSON part, at most `maxSizeMb`.
 */
function buildUploadLimits (maxSizeMbSetting: unknown, maxFilesSetting: unknown): { maxSizeMb: number, maxFiles: number, limits: UploadLimits } {
  const maxSizeMb = effectiveMaxSizeMb(maxSizeMbSetting);
  let maxFiles = Number(maxFilesSetting);
  if (maxFilesSetting == null || !Number.isInteger(maxFiles) || maxFiles <= 0) maxFiles = DEFAULT_MAX_FILES;
  const maxSizeBytes = maxSizeMb * 1024 * 1024;
  const fields = 1;
  return {
    maxSizeMb,
    maxFiles,
    limits: {
      fileSize: maxSizeBytes, // per uploaded file
      // The JSON part keeps parity with the express.json body limit; with a
      // single non-file part allowed, a request buffers at most one of them.
      fieldSize: maxSizeBytes,
      fields,
      files: maxFiles,
      parts: maxFiles + fields
    }
  };
}

// Built lazily on first request. Config is only readable once boiler has
// finished its async init, and this module is required while routes are
// registered (before that completes), so the multer instance cannot be built
// at module scope.
let uploadMiddlewareFactory: MulterUploadFactory | null = null;
let appliedMaxSizeMb = DEFAULT_MAX_SIZE_MB;

function getUploadMiddlewareFactory (): MulterUploadFactory {
  if (uploadMiddlewareFactory != null) return uploadMiddlewareFactory;
  const config = getConfigSync();
  const { maxSizeMb, limits } = buildUploadLimits(config.get('uploads:maxSizeMb'), config.get('uploads:maxFiles'));
  appliedMaxSizeMb = maxSizeMb;
  const built: MulterUploadFactory = multer({
    storage,
    limits,
    fileFilter: (req: Request, file: { originalname: string }, cb: (error: Error | null, acceptFile: boolean) => void) => {
      file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
      cb(null, true);
    }
  });
  uploadMiddlewareFactory = built;
  return built;
}

/** The paths of the files the parser wrote for this request (`req.files` right after parsing). */
function writtenPaths (files: unknown): string[] {
  const list = Array.isArray(files) ? files : (files != null && typeof files === 'object' ? Object.values(files).flat() : []);
  const paths: string[] = [];
  for (const file of list) {
    if (file != null && typeof file === 'object' && typeof (file as { path?: unknown }).path === 'string') {
      paths.push((file as { path: string }).path);
    }
  }
  return paths;
}

function removeWrittenFiles (paths: string[]) {
  for (const filePath of paths) {
    removeUploadedFile(filePath).catch((err: Error) => {
      getLogger('uploads').warn('Could not remove an upload temp file: ' + err.message);
    });
  }
}
// --------------------------------------------------------------------- exports
export { filesUploadSupport, hasFileUpload, buildUploadLimits, effectiveMaxSizeMb };
/** Declares that a route has file uploads.
 *
 * Enables file uploads on a route. file uploads are checked in their global
 * form (MUST have only a JSON body).
 *
 * The temp files the parser writes are deleted once the response is finished
 * or the connection closed, whatever the outcome; the parser itself removes
 * them when it aborts on an error.
 */
function hasFileUpload (req: Request, res: Response, next: NextFunction) {
  const uploadMiddleware = getUploadMiddlewareFactory().any();
  // Only paths taken from the parser's own output for this request, captured
  // before any later handler can touch `req.files`.
  let paths: string[] = [];
  let responseEnded = false;
  const onResponseEnd = () => {
    if (responseEnded) return;
    responseEnded = true;
    removeWrittenFiles(paths);
  };
  res.once('finish', onResponseEnd);
  res.once('close', onResponseEnd);
  uploadMiddleware(req, res, (err: unknown) => {
    paths = writtenPaths((req as Request & { files?: unknown }).files);
    // The response may already be gone (client disconnected while files were
    // still being written): nothing else will remove them.
    if (responseEnded) removeWrittenFiles(paths);
    if (err != null) {
      if (err instanceof multer.MulterError) {
        const code = (err as { code?: string }).code;
        const field = (err as { field?: string }).field;
        // multer's size overruns carry a `.code` but no `.status`, so without
        // this mapping they would fall through the error middleware as opaque
        // 500s. A too-large upload is a client fault: answer 413.
        if (code === 'LIMIT_FILE_SIZE' || code === 'LIMIT_FIELD_VALUE') {
          return next(errorsFactory.payloadTooLarge(
            `Uploaded data exceeds the maximum allowed size of ${appliedMaxSizeMb}MB (see uploads.maxSizeMb).`,
            { limitMb: appliedMaxSizeMb, field }));
        }
        // Any other multipart parse failure (including too many files or
        // non-file parts) is a malformed request, not a server error.
        return next(errorsFactory.invalidRequestStructure((err as Error).message));
      }
      return next(err);
    }
    filesUploadSupport(req, res, next);
  });
}
