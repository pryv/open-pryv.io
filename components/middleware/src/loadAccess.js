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
// Returns a middleware function that loads the access into `req.context.access`.
// The access is loaded from the token previously extracted by the `initContext` middleware.
// Also, it adds the corresponding access id as a specific response header.
//
module.exports = function loadAccess (storageLayer) {
  return async function (req, res, next) {
    try {
      await req.context.retrieveExpandedAccess(storageLayer);
      // Add access id header
      setAccessIdHeader(req, res);
      next();
    } catch (err) {
      // Also set the header in case of error
      setAccessIdHeader(req, res);
      next(err);
    }
  };
};
/**
 * Adds the id of the access (if any was used during API call)
 * within the `Pryv-Access-Id` header of the given result.
 * It is extracted from the request context.
 *
 * @param {express$Request} req  Current express request.
 * @param {express$Response} res  Current express response. MODIFIED IN PLACE.
 * @returns {any}
 */
function setAccessIdHeader (req, res) {
  if (req != null) {
    const requestCtx = req.context;
    if (requestCtx != null && requestCtx.access != null) {
      res.header('Pryv-Access-Id', requestCtx.access.id);
    }
  }
  return res;
}
