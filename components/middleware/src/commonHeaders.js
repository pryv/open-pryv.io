/**
 * @license
 * Copyright (c) 2020 Pryv S.A. https://pryv.com
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
 * 
 */
// @flow

// Middleware to handle OPTIONS requests and to add CORS headers to all other 
// requests. 

module.exports = function (version: string) {
  return function (req: express$Request, res: express$Response, next: express$NextFunction) {
    // allow cross-domain requests (CORS)
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    // *
    res.header('Access-Control-Allow-Methods', req.headers['access-control-request-method'] ||
        'POST, GET, PUT, DELETE, OPTIONS');
    // *
    res.header('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] ||
        'Authorization, Content-Type');
    res.header('Access-Control-Expose-Headers', 'API-Version');
    // *
    res.header('Access-Control-Max-Age', (60 * 60 * 24 * 365).toString());
    res.header('Access-Control-Allow-Credentials', 'true');

    // keep API version in HTTP headers for now
    res.header('API-Version', version);
    
    if (req.method == 'OPTIONS') {
      res.sendStatus(200);
      return;
    }

    next();
  };
};