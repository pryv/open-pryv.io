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
const db = require('../storage/database');
const messages = require('../utils/messages');
const config = require('../config');
const checkAndConstraints = require('../utils/check-and-constraints');
const domain = config.get('dns:domain');
const accessLib = (module.exports = {});
const logger = require('winston');

const info = require('./service-info');

/** Update an app access state in the database.
 *
 * @param {string} key: the key referencing the access to be updated
 * @param {AccessState} accessState: the new state of this access, which is defined by parameters like:
 *  status (NEED_SIGNIN, ACCEPTED, REFUSED), requesting app id, requested permissions, etc.
 * @param {(a: AccessState) => unknown} successHandler: callback in case of success
 * @param {(a: any) => unknown} errorCallback: callback in case of error
 */
accessLib.setAccessState = function (
  key,
  accessState,
  successHandler,
  errorCallback
) {
  db.setAccessState(key, accessState, function (error) {
    if (error) {
      return errorCallback(messages.ei(error));
    }
    return successHandler(accessState);
  });
};

/**
 * @typedef {{
 *   requestingAppId?: unknown
 *   requestedPermissions?: unknown
 *   languageCode?: unknown
 *   oauthState?: unknown
 *   localDevel?: unknown
 *   backloopDevel?: unknown
 *   returnURL?: unknown
 *   clientData?: unknown
 *   authUrl?: string
 *   serviceInfo?: unknown
 *   deviceName?: string
 *   expireAfter?: number
 *   referer?: string
 * }} RequestAccessParameters
 */

/**
 * Request and generate an app access
 * @param {RequestAccessParameters} parameters: parameters defining the access such as:
 *  requesting app id, requested permissions, language code, return url, oauth or other dev options
 * @param {(a: any) => unknown} successHandler: callback in case of success
 * @param {(a: any) => unknown} errorHandler: callback in case of error
 * @returns {*}
 */
accessLib.requestAccess = function (parameters, successHandler, errorHandler) {
  // Parameters
  const requestingAppId = checkAndConstraints.appID(parameters.requestingAppId);
  if (!requestingAppId) {
    return errorHandler(
      messages.e(400, 'INVALID_APP_ID', {
        requestingAppId: parameters.requestingAppId
      })
    );
  }

  // We don't currently verify the contents of the requested permissions.
  const requestedPermissions = checkAndConstraints.access(parameters.requestedPermissions);
  if (requestedPermissions == null) {
    return errorHandler(messages.e(400, 'INVALID_DATA',
      { detail: 'Missing or invalid requestedPermissions field' }));
  }

  const lang = checkAndConstraints.lang(parameters.languageCode);
  if (lang == null) return errorHandler(messages.e(400, 'INVALID_LANGUAGE'));

  const returnURL = parameters.returnURL;
  const oauthState = parameters.oauthState;
  const clientData = parameters.clientData;
  const serviceInfo = parameters.serviceInfo;

  let effectiveReturnURL;
  if (returnURL == null || typeof returnURL === 'string') {
    effectiveReturnURL = returnURL;
  } else if (typeof returnURL === 'boolean' && returnURL === false) {
    // deprecated
    logger.warn('Deprecated: received returnURL=false, this optional parameter must be a string.');

    effectiveReturnURL = null;
  } else {
    return errorHandler(messages.e(400, 'INVALID_DATA', { detail: 'Invalid returnURL field.' }));
  }

  const key = randGenerator(16);
  const pollURL = info.access + key;

  if (serviceInfo != null) {
    if (!isServiceInfoValid(serviceInfo)) {
      return errorHandler(messages.e(400, 'INVALID_SERVICE_INFO_URL', { detail: serviceInfo }));
    }
  }

  let url;
  if (parameters.authUrl != null) {
    url = parameters.authUrl;
    if (!isAuthURLValid(url)) {
      return errorHandler(messages.e(400, 'INVALID_AUTH_URL', { detail: 'domain : ' + domain + ' / auth : ' + url }));
    }
    if (!isAuthDomainTrusted(url)) {
      return errorHandler(messages.e(400, 'UNTRUSTED_AUTH_URL', { detail: 'domain : ' + domain + ' / auth : ' + url }));
    }
  } else {
    url = config.get('access:defaultAuthUrl');
  }

  const deviceName = parameters.deviceName;
  if (deviceName != null && typeof deviceName !== 'string') {
    return errorHandler(messages.e(400, 'INVALID_DEVICE_NAME', { detail: 'deviceName : ' + deviceName }));
  }

  const expireAfter = parameters.expireAfter;
  if (expireAfter != null && typeof expireAfter !== 'number') {
    return errorHandler(messages.e(400, 'INVALID_EXPIRE_AFTER', { detail: 'expireAfter : ' + expireAfter }));
  }

  const referer = parameters.referer;
  if (referer != null && typeof referer !== 'string') {
    return errorHandler(messages.e(400, 'INVALID_REFERER', { detail: 'referer : ' + referer }));
  }

  const backloopDevel = parameters.backloopDevel;
  if (typeof backloopDevel === 'string') {
    url = 'https://sw.backloop.dev' + backloopDevel;
  }

  const firstParamAppender = url.indexOf('?') >= 0 ? '&' : '?';

  let authUrl;
  authUrl = url + firstParamAppender;

  url = url +
    firstParamAppender +
    'lang=' + lang +
    '&key=' + key +
    '&requestingAppId=' + requestingAppId;

  if (effectiveReturnURL != null) { url += '&returnURL=' + encodeURIComponent(effectiveReturnURL); }

  url +=
    '&domain=' + domain +
    '&registerURL=' + encodeURIComponent(info.register);

  url += '&poll=' + encodeURIComponent(pollURL);

  const cleanOauthState = typeof oauthState === 'string' ? oauthState : null;

  if (cleanOauthState != null) url += '&oauthState=' + cleanOauthState;

  /**
   * this should be poll instead of pollUrl (as in accessState)
   */
  authUrl += '&pollUrl=' + encodeURIComponent(pollURL);

  const accessState = {
    status: 'NEED_SIGNIN',
    code: 201,
    key,
    requestingAppId,
    requestedPermissions,
    url,
    authUrl,
    poll: pollURL,
    returnURL: effectiveReturnURL,
    oauthState: cleanOauthState,
    poll_rate_ms: 1000,
    clientData,
    lang,
    serviceInfo,
    deviceName,
    expireAfter,
    referer
  };

  accessLib.setAccessState(key, accessState, successHandler, errorHandler);
};

/**
 * @param {string} url
 * @returns {boolean}
 */
function isAuthURLValid (url) {
  return checkAndConstraints.url(url);
}

const trustedAuthUrls = config.get('access:trustedAuthUrls');
trustedAuthUrls.push(config.get('access:defaultAuthUrl'));

/**
 * @param {string} url
 * @returns {boolean}
 */
function isAuthDomainTrusted (url) {
  for (let i = 0; i < trustedAuthUrls.length; i++) {
    if (url.startsWith(trustedAuthUrls[i])) {
      return true;
    }
  }
  return false;
}

/**
 * @param {unknown} serviceInfo
 * @returns {boolean}
 */
function isServiceInfoValid (serviceInfo) {
  return !!(serviceInfo && serviceInfo.name);
}

/**
 * Check the validity of the access by checking its associated key.
 * @param {string} key
 * @param {(res: AccessState) => unknown} success
 * @param {(err: Error) => unknown} failed
 * @returns
 */
accessLib.testKeyAndGetValue = function (key, success, failed) {
  if (!checkAndConstraints.accesskey(key)) {
    return failed(messages.e(400, 'INVALID_KEY'));
  }

  db.getAccessState(key, function (error, result) {
    if (error != null) return failed(messages.ei(error));
    if (result == null) return failed(messages.e(400, 'INVALID_KEY'));

    success(result);
  });
};

/**
 * Local random key generator
 * @param stringLength: the key length
 * @returns {string} : the generated key
 */
function randGenerator (stringLength) {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXTZabcdefghiklmnopqrstuvwxyz';
  let randomstring = '';
  for (let i = 0; i < stringLength; i++) {
    randomstring += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return randomstring;
}
