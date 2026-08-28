/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Request, Response, NextFunction } from 'express';
const require = createRequire(import.meta.url);
'use strict';
// A middleware that allows checking uploads and that will at the same time
// allow uploads for the route.
const filesUploadSupport = require('middleware').filesUploadSupport;
const multer = require('multer');
const integrity = require('business').integrity;
const errorsFactory = require('errors').factory;
const { getConfigSync } = require('@pryv/boiler');
// load the correct disk storage depending on settings
const MulterDiskStorage = integrity.attachments.isActive
  ? integrity.attachments.MulterIntegrityDiskStorage
  : multer.diskStorage;
// ---------------------------------------------------------------- multer setup
// Parse multipart file data into request.files:
const storage = MulterDiskStorage({
  filename: null,
  destination: null // operating system's default directory for temporary files is used.
});

interface MulterUploadFactory {
  any: () => (req: Request, res: Response, cb: (err: unknown) => void) => void;
}

// Built lazily on first request. The upload ceiling is `uploads.maxSizeMb`,
// which mirrors the express.json() body limit; config is only readable once
// boiler has finished its async init, and this module is required while routes
// are registered (before that completes), so the multer instance cannot be
// built at module scope.
let uploadMiddlewareFactory: MulterUploadFactory | null = null;
let configuredMaxSizeMb = 0;
let hasConfiguredLimit = false;

function getUploadMiddlewareFactory (): MulterUploadFactory {
  if (uploadMiddlewareFactory != null) return uploadMiddlewareFactory;
  const config = getConfigSync();
  configuredMaxSizeMb = Number(config.get('uploads:maxSizeMb'));
  // A finite, positive limit only: an absent/zero/garbage override leaves the
  // file part unbounded (its previous behaviour) rather than feeding NaN to the
  // parser. Note multer still enforces its own 1MB fieldSize default in that
  // case, so the 413 branch below is gated on an actual configured limit to
  // avoid citing a NaN size.
  const limits: { fileSize?: number, fieldSize?: number } = {};
  if (Number.isFinite(configuredMaxSizeMb) && configuredMaxSizeMb > 0) {
    const maxSizeBytes = configuredMaxSizeMb * 1024 * 1024;
    limits.fileSize = maxSizeBytes; // per uploaded file
    limits.fieldSize = maxSizeBytes; // the non-file (JSON) part, parity with express.json
    hasConfiguredLimit = true;
  }
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
// --------------------------------------------------------------------- exports
export { filesUploadSupport, hasFileUpload };
/** Declares that a route has file uploads.
 *
 * Enables file uploads on a route. file uploads are checked in their global
 * form (MUST have only a JSON body).
 */
function hasFileUpload (req: Request, res: Response, next: NextFunction) {
  const uploadMiddleware = getUploadMiddlewareFactory().any();
  uploadMiddleware(req, res, (err: unknown) => {
    if (err != null) {
      if (err instanceof multer.MulterError) {
        const code = (err as { code?: string }).code;
        const field = (err as { field?: string }).field;
        // multer's size overruns carry a `.code` but no `.status`, so without
        // this mapping they would fall through the error middleware as opaque
        // 500s. A too-large upload is a client fault: answer 413.
        if (hasConfiguredLimit && (code === 'LIMIT_FILE_SIZE' || code === 'LIMIT_FIELD_VALUE')) {
          return next(errorsFactory.payloadTooLarge(
            `Uploaded data exceeds the maximum allowed size of ${configuredMaxSizeMb}MB (see uploads.maxSizeMb).`,
            { limitMb: configuredMaxSizeMb, field }));
        }
        // Any other multipart parse failure is a malformed request, not a
        // server error.
        return next(errorsFactory.invalidRequestStructure((err as Error).message));
      }
      return next(err);
    }
    filesUploadSupport(req, res, next);
  });
}
