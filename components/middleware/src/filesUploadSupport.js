/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
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
const errors = require('errors').factory;
/** Transparently handles multipart requests for uploading file attachments.
 *
 * Files uploaded, if any, will be in req.files. All other field parts are
 * reunited in the body object by multer; after the execution of this middleware,
 * the `req.body` is replaced by its only child object. If there is more than
 * one such object in `req.body`, an error is thrown.
 *
 * @example
 *    {
 *      event: { foo: 'bar' }
 *    }
 *
 *    // is turned into
 *
 *    {
 *      foo: 'bar'
 *    }
 *
 * @param {express$Request} req  request object
 * @param {express$Response} res  response object
 * @param {Function} next  callback for next middleware in chain
 * @return {any}
 */
function validateFileUpload (req, res, next) {
  const body = req.body;
  if (req.is('multipart/form-data') &&
        body != null &&
        typeof body === 'object') {
    const bodyKeys = Object.keys(body);
    if (bodyKeys.length > 1) {
      return next(errors.invalidRequestStructure("In multipart requests, we don't expect more than one non-file part."));
    }
    if (bodyKeys.length === 0) {
      return next();
    }
    // assert: bodyKeys.length === 1
    // The only content that is not a file MUST be JSON.
    try {
      const key = bodyKeys[0];
      const contents = body[key];
      if (typeof contents !== 'string') {
        throw new Error('JSON body must be a string.');
      }
      req.body = JSON.parse(contents);
    } catch (error) {
      return next(errors.invalidRequestStructure('In multipart requests, we expect the non-file part to be valid JSON.'));
    }
  }
  return next();
}
module.exports = validateFileUpload;
