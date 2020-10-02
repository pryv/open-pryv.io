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

const request = require('superagent');
const fs = require('fs');
const url = require('url');
const path = require('path');

const regPath = require('components/api-server/src/routes/Paths').Register;
const wwwPath = require('components/api-server/src/routes/Paths').WWW;

let serviceInfo = {};

const FILE_PROTOCOL = 'file://';
const FILE_PROTOCOL_LENGTH = FILE_PROTOCOL.length;
const SERVICE_INFO_PATH = '/service/info';
const REGISTER_URL_CONFIG = 'services.register.url';
const SERVICE_INFO_URL_CONFIG = 'serviceInfoUrl';
const SINGLE_NODE_VERSION_CONFIG = 'singleNode.isActive'; 
const SINGLE_NODE_PUBLIC_URL_CONFIG = 'singleNode.publicUrl';

class ServiceInfo {

  static async loadFromUrl(serviceInfoUrl) {
    if (serviceInfo[serviceInfoUrl]) return serviceInfo[serviceInfoUrl];

    if (isFileUrl(serviceInfoUrl)) {
      const filePath = stripFileProtocol(serviceInfoUrl);
      
      if (isRelativePath(filePath)) {
        const serviceCorePath = path.resolve(__dirname, '../../../../../');
        serviceInfoUrl = path.resolve(serviceCorePath, filePath);
        serviceInfoUrl = 'file://' + serviceInfoUrl;
      } else {
        // absolute path, do nothing.
      }
    }
    if (process.env.NODE_ENV !== 'test')
      console.info('Fetching serviceInfo from: ' + serviceInfoUrl);
    if (serviceInfoUrl == null) {
      console.error('Parameter "serviceInfoUrl" is undefined, set it in the configuration to allow core to provide service info');
      process.exit(2);
      return null;
    }
    let result = null;
    try {
      if (isFileUrl(serviceInfoUrl)) {
        result = JSON.parse(fs.readFileSync(stripFileProtocol(serviceInfoUrl), 'utf8'));
      } else {
        const res = await request.get(serviceInfoUrl);
        result = res.body;
      }
    } catch (error) {
      console.error('Failed fetching "serviceInfoUrl" ' + serviceInfoUrl + ' with error' + error.message);
      process.exit(2);
      return null;
    }
    serviceInfo[serviceInfoUrl] = result;
    return serviceInfo[serviceInfoUrl];
  }

  static async addToConvict(convictInstance) {

    let isSingleNode = convictInstance.get(SINGLE_NODE_VERSION_CONFIG);
    if (isSingleNode) {
      let singleNodePublicUrl = convictInstance.get(SINGLE_NODE_PUBLIC_URL_CONFIG);
      if (singleNodePublicUrl.slice(-1) === '/') singleNodePublicUrl = singleNodePublicUrl.slice(0, -1);
      convictInstance.set('service.serial', 't' + Math.round(Date.now() / 1000));
      convictInstance.set('service.api', singleNodePublicUrl + '/{username}/');
      convictInstance.set('service.register', singleNodePublicUrl + regPath + '/');
      convictInstance.set('service.access', singleNodePublicUrl + regPath + '/access/');
      convictInstance.set('service.eventTypes', 'https://api.pryv.com/event-types/flat.json');
      convictInstance.set('service.assets', {
        definitions: singleNodePublicUrl + wwwPath + '/assets/index.json',
      });
      return;
    }

    // -- from url
    let serviceInfoUrl;
    try {
      serviceInfoUrl = convictInstance.get(SERVICE_INFO_URL_CONFIG);
      // HACK: in tests, convictInstance is convict(), with bin/server it is hfs/src/config
      serviceInfoUrl = serviceInfoUrl.value || serviceInfoUrl;
    } catch (e) {
      console.info(SERVICE_INFO_URL_CONFIG + ' not provided. Falling back to ' + REGISTER_URL_CONFIG);
    }
    if (serviceInfoUrl == null) {
      try {
        serviceInfoUrl = convictInstance.get(REGISTER_URL_CONFIG);
        // HACK: in tests, convictInstance is convict(), with bin/server it is hfs/src/config
        serviceInfoUrl = serviceInfoUrl.value || serviceInfoUrl;
        serviceInfoUrl = url.resolve(serviceInfoUrl, SERVICE_INFO_PATH);
      } catch (e) {
        console.error('Configuration error: ' + REGISTER_URL_CONFIG + 
        ' not provided. Please provide either ' + REGISTER_URL_CONFIG + 
        ' or ' + SERVICE_INFO_URL_CONFIG + ' to boot service.');
      }
    }
    const serviceInfo = await ServiceInfo.loadFromUrl(serviceInfoUrl);
    convictInstance.set('service', serviceInfo);
    return;
  }
}

module.exports = ServiceInfo;

function isFileUrl(serviceInfoUrl) {
  return serviceInfoUrl.startsWith(FILE_PROTOCOL);
}

function isRelativePath(filePath) {
  return ! path.isAbsolute(filePath);
}

function stripFileProtocol(filePath) {
  return filePath.substring(FILE_PROTOCOL_LENGTH);
}