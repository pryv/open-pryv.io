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
const errors = require('errors').factory;
/**
 * Middleware to allow overriding HTTP method, "Authorization" header and JSON
 * body content by sending them as fields in urlencoded requests. Does not
 * perform request body parsing (expects req.body to exist), so must be executed
 * after e.g. bodyParser middleware.
 * @param {RequestWithOriginalMethodAndBody} req
 * @param {express$Response} res
 * @param {express$NextFunction} next
 * @returns {any}
 */
function normalizeRequest (req, res, next) {
  if (!req.is('application/x-www-form-urlencoded')) {
    return next();
  }
  const body = req.body;
  if (body == null || typeof body !== 'object') { return next(); }
  if (typeof body._method === 'string') {
    req.originalMethod = req.originalMethod || req.method;
    req.method = body._method.toUpperCase();
    delete body._method;
  }
  if (body._auth) {
    if (req.headers.authorization) {
      req.headers['original-authorization'] = req.headers.authorization;
    }
    req.headers.authorization = body._auth;
    delete body._auth;
  }
  if (typeof body._json === 'string') {
    req.originalBody = req.originalBody || body;
    try {
      req.body = JSON.parse(body._json);
    } catch (err) {
      return next(errors.invalidRequestStructure(err.message));
    }
  }
  next();
}
module.exports = normalizeRequest;
