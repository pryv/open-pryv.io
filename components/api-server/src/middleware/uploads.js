/**
 * @license
 * Copyright (C) 2020-2021 Pryv S.A. https://pryv.com 
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
 */
'use strict'; 
// @flow

// A middleware that allows checking uploads and that will at the same time
// allow uploads for the route. 

const filesUploadSupport = require('middleware').filesUploadSupport;
const multer = require('multer');
const integrity = require('business').integrity;

// load the correct disk storage depending on settings
const MulterDiskStorage = integrity.attachments.isActive ? integrity.attachments.MulterIntegrityDiskStorage : multer.diskStorage;

// ---------------------------------------------------------------- multer setup

// Parse multipart file data into request.files: 
const storage = MulterDiskStorage({
  filename: null, // default filename, random
  destination: null, // operating system's default directory for temporary files is used.
}); 
const uploadMiddlewareFactory = multer({storage: storage});

// --------------------------------------------------------------------- exports
module.exports = {
  filesUploadSupport: filesUploadSupport, 
  hasFileUpload: hasFileUpload,
};



/** Declares that a route has file uploads. 
 * 
 * Enables file uploads on a route. file uploads are checked in their global
 * form (MUST have only a JSON body). 
 */ 
function hasFileUpload(req: express$Request, res: express$Response, next: express$NextFunction) {
  const uploadMiddleware = uploadMiddlewareFactory.any(); 
  
  uploadMiddleware(req, res, (err) => {
    if (err) return next(err);
    
    filesUploadSupport(req, res, next);
  });
}

