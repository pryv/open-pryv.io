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

const request = require('superagent');
const fs = require('fs');
const url = require('url');
const path = require('path');

const Config = require('../Config');

const regPath: string = require('components/api-server/src/routes/Paths').Register;
const wwwPath: string = require('components/api-server/src/routes/Paths').WWW;

const FILE_PROTOCOL: string = 'file://';
const FILE_PROTOCOL_LENGTH: number = FILE_PROTOCOL.length;
const SERVICE_INFO_PATH: string = '/service/info';

async function load (config: Config): Config {
  const serviceInfoUrl: string = config.get('serviceInfoUrl');
  let isDnsLess: boolean = config.get('dnsLess:isActive');

  if (process.env.NODE_ENV !== 'test')
    console.info('Fetching serviceInfo from: ' + serviceInfoUrl);

  if (serviceInfoUrl == null && !isDnsLess) {
    console.error(
      'Parameter "serviceInfoUrl" is undefined, set it in the configuration to allow core to provide service info'
    );
    process.exit(2);
    return null;
  }

  try {
    let serviceInfo: ?{};
    if (isDnsLess) {
      serviceInfo = buildServiceInfo(config);
    } else if (isFileUrl(serviceInfoUrl)) {
      serviceInfo = loadFromFile(serviceInfoUrl);
    } else {
      serviceInfo = await loadFromUrl(serviceInfoUrl);
    }
    if (serviceInfo == null) {
      exitServiceInfoNotFound(serviceInfoUrl);
    }
    config.set('service', serviceInfo);
  } catch (err) {
    exitServiceInfoNotFound(serviceInfoUrl, err);
  }
  
}
module.exports.load = load;

function buildServiceInfo(config: {}): {} {
  let serviceInfo: {} = {};

  let dnsLessPublicUrl: string = config.get('dnsLess:publicUrl');

  if (dnsLessPublicUrl == null || (typeof dnsLessPublicUrl != 'string')) {
    console.error('Core started in dnsLess mode, but invalid publicUrl was set: "' + dnsLessPublicUrl + '". Exiting');
    process.exit(2);
  }

  if (dnsLessPublicUrl.slice(-1) === '/') dnsLessPublicUrl = dnsLessPublicUrl.slice(0, -1);

  serviceInfo.serial = 't' + Math.round(Date.now() / 1000);
  serviceInfo.api = dnsLessPublicUrl + '/{username}/';
  serviceInfo.register = dnsLessPublicUrl + regPath + '/';
  serviceInfo.access = dnsLessPublicUrl + regPath + '/access/';
  serviceInfo.assets = {
    definitions: dnsLessPublicUrl + wwwPath + '/assets/index.json',
    };
  return serviceInfo;
}

async function loadFromUrl(serviceInfoUrl: string): Promise<{}> {
  const res = await request.get(serviceInfoUrl);
  return res.body;
}

function loadFromFile(serviceInfoUrl: string): {} {
  const filePath: string = stripFileProtocol(serviceInfoUrl);

  if (isRelativePath(filePath)) {
    const serviceCorePath: string = path.resolve(__dirname, '../../../../../');
    serviceInfoUrl = path.resolve(serviceCorePath, filePath);
    serviceInfoUrl = 'file://' + serviceInfoUrl;
  } else {
    // absolute path, do nothing.
  }
  const serviceInfo: {} = JSON.parse(
    fs.readFileSync(stripFileProtocol(serviceInfoUrl), 'utf8')
  );
  return serviceInfo;
}

function exitServiceInfoNotFound(serviceInfoUrl: string, err?: {}): void {
  if (err == null) err.message = 'error';
  console.error('Failed fetching serviceInfo at URL ' + serviceInfoUrl + ' with error: ' + err.message);
  process.exit(2);
}

function isFileUrl(serviceInfoUrl: string): boolean {
  return serviceInfoUrl.startsWith(FILE_PROTOCOL);
}

function isRelativePath(filePath: string): boolean {
  return !path.isAbsolute(filePath);
}

function stripFileProtocol(filePath: string): string {
  return filePath.substring(FILE_PROTOCOL_LENGTH);
}
