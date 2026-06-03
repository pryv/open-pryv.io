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
const uploadMiddlewareFactory = multer({
  storage,
  fileFilter: (req: Request, file: { originalname: string }, cb: (error: Error | null, acceptFile: boolean) => void) => {
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, true);
  }
});
// --------------------------------------------------------------------- exports
export { filesUploadSupport, hasFileUpload };
/** Declares that a route has file uploads.
 *
 * Enables file uploads on a route. file uploads are checked in their global
 * form (MUST have only a JSON body).
 * @param {express$Request} req
 * @param {express$Response} res
 * @param {express$NextFunction} next
 * @returns {void}
 */
function hasFileUpload (req: Request, res: Response, next: NextFunction) {
  const uploadMiddleware = uploadMiddlewareFactory.any();
  uploadMiddleware(req, res, (err: Error | null) => {
    if (err) { return next(err); }
    filesUploadSupport(req, res, next);
  });
}
