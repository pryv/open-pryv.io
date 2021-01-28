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

const timestamp = require('unix-timestamp');
const _ = require('lodash');
const { ProjectVersion } = require('middleware/src/project_version');
// cnan be overriden;
const { getConfig } = require('boiler');

type MetaInfo = {
  meta: {
    apiVersion: string, 
    serverTime: number, 
    serial: string
  }
}

// NOTE There's really no good way to wait for an asynchronous process in a 
//  synchronous method. But we don't want to modify all the code that uses
//  setCommonMeta either; ideally, we'd have a chain of dependencies leading
//  here and this would have some state. Then we could load the version once 
//  and store it forever. This (init and memoise) is the next best thing. 

// Memoised copy of the current project version. 
let version: string = 'n/a';
let serial: ?string = null;
let config = null;

// Initialise the project version as soon as we can. 
const pv = new ProjectVersion(); 
version = pv.version();

/**
 * 
 * If no parameter is provided, loads the configuration. Otherwise takes the provided loaded settings.
 */
module.exports.loadSettings = async function (): Promise<void> {
  config = await getConfig();
};

/**
 * Adds common metadata (API version, server time) in the `meta` field of the given result,
 * initializing `meta` if missing.
 *
 * Warning : the new `settings` parameter is a slight "hack" (almost like `version`)
 * to set and cache the serial when core starts.
 * We REALLY should refactor this method.
 *
 * @param result {Object} Current result. MODIFIED IN PLACE. 
 */
module.exports.setCommonMeta = function <T: Object>(result: T): T & MetaInfo {
  if (result.meta == null) {
    result.meta = {};
  }

  if (serial == null && config != null) {
    serial = config.get('service:serial');
  }
  
  _.extend(result.meta, {
    apiVersion: version,
    serverTime: timestamp.now(),
    serial: serial
  });
  return result;
};
