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

const headPath = require('../../api-server/src/routes/Paths').Register;
const wwwPath = require('../../api-server/src/routes/Paths').WWW;

const config = {
  'auth:authorizedKeys': {},
  'dns:domain': 'open-pryv.io',
  'appList': []
}

module.exports = {
  get: function(key) {
    return config[key];
  },
  loadSettings: function(settings) {
    config.service = settings.get('service').obj();
    let publicUrl = settings.get('dnsLess.publicUrl').str();
    if (publicUrl.slice(-1) === '/') publicUrl = publicUrl.slice(0, -1);
    config.publicUrl = publicUrl;
    config['access:trustedAuthUrls'] = [publicUrl];
    config['access:defaultAuthUrl'] = [publicUrl + wwwPath +'/access/access.html'];

    // load admin keys
    config.adminKey = settings.get('auth.adminAccessKey').str();
    if (config.adminKey) {
      config['auth:authorizedKeys'][config.adminKey] = { roles: ['admin'] }
    }
  }
}