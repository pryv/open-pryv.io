/**
 * @license
 * Copyright (C) 2020 Pryv S.A. https://pryv.com - All Rights Reserved
 * Unauthorized copying of this file, via any medium is strictly prohibited
 * Proprietary and confidential
 */
// @flow

const db = require('../storage/database');
const messages = require('../utils/messages');
const config = require('../config');
const checkAndConstraints = require('../utils/check-and-constraints');
const domain = config.get('dns:domain');
const accessLib = module.exports = {};
const logger = require('winston');

const info = require('./service-info');

import type { AccessState } from '../storage/database';


/** Update an app access state in the database.
 * 
 * @param key: the key referencing the access to be updated
 * @param accessState: the new state of this access, which is defined by parameters like:
 *  status (NEED_SIGNIN, ACCEPTED, REFUSED), requesting app id, requested permissions, etc.
 * @param successHandler: callback in case of success
 * @param errorCallback: callback in case of error
 */
accessLib.setAccessState = function (
  key: string, accessState: AccessState, 
  successHandler: (AccessState) => mixed, 
  errorCallback: (any) => mixed, 
) {
  db.setAccessState(key, accessState, function (error) {
    if (error) {
      return errorCallback(messages.ei());
    }
    return successHandler(accessState);
  });
};

type RequestAccessParameters = {
  requestingAppId?: mixed, 
  requestedPermissions?: mixed, 
  languageCode?: mixed, 
  oauthState?: mixed, 
  localDevel?: mixed, 
  reclaDevel?: mixed, 
  returnURL?: mixed, 
  clientData?: mixed, 
  authUrl?: string,
  serviceInfo?: mixed,
  deviceName?: string,
  expireAfter?: number,
  referer?: string,
}


/**
 * Request and generate an app access
 * @param parameters: parameters defining the access such as:
 *  requesting app id, requested permissions, language code, return url, oauth or other dev options
 * @param successHandler: callback in case of success
 * @param errorHandler: callback in case of error
 * @returns {*}
 */
accessLib.requestAccess = function (
  parameters: RequestAccessParameters, 
  successHandler: (any) => mixed, 
  errorHandler: (any) => mixed, 
) {
  // Parameters
  const requestingAppId = checkAndConstraints.appID(parameters.requestingAppId);
  if (!requestingAppId) {
    return errorHandler(messages.e(400, 'INVALID_APP_ID',
      {requestingAppId: parameters.requestingAppId}));
  }

  // FLOW We don't currently verify the contents of the requested permissions. 
  const requestedPermissions = checkAndConstraints.access(parameters.requestedPermissions);
  if (requestedPermissions == null) {
    return errorHandler(messages.e(400, 'INVALID_DATA',
      {detail: 'Missing or invalid requestedPermissions field'}));
  }
  
  const lang = checkAndConstraints.lang(parameters.languageCode);
  if (lang == null) 
    return errorHandler(messages.e(400, 'INVALID_LANGUAGE'));

  const returnURL = parameters.returnURL;
  const oauthState = parameters.oauthState;
  const clientData = parameters.clientData;
  const serviceInfo = parameters.serviceInfo;

  let effectiveReturnURL; 
  if ((returnURL == null) || (typeof returnURL === 'string')) {
    effectiveReturnURL = returnURL;
  } else if ((typeof returnURL === 'boolean') && (returnURL === false)) {
    // deprecated
    logger.warn('Deprecated: received returnURL=false, this optional parameter must be a string.');

    effectiveReturnURL = null; 
  } else {
    return errorHandler(messages.e(400, 'INVALID_DATA', { detail: 'Invalid returnURL field.' }));
  }

  const key = randGenerator(16);
  const pollURL = info.access + key; 
  
  if (serviceInfo != null) {
    if (! isServiceInfoValid(serviceInfo)) {
      return errorHandler(messages.e(400, 'INVALID_SERVICE_INFO_URL', { detail: serviceInfo }));
    }
  }

  let url: string;
  if(parameters.authUrl != null) {
    url = parameters.authUrl;
    if(!isAuthURLValid(url)) {
      return errorHandler(messages.e(400, 'INVALID_AUTH_URL', { detail: 'domain : '+domain+' / auth : ' + url }));
    }
    if(!isAuthDomainTrusted(url)) {
      return errorHandler(messages.e(400, 'UNTRUSTED_AUTH_URL', { detail: 'domain : '+domain+' / auth : ' + url }));
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

  const reclaDevel = parameters.reclaDevel; 
  if (typeof reclaDevel === 'string') {
    url = 'https://sw.rec.la' + reclaDevel;
  }

  let firstParamAppender = (url.indexOf('?') >= 0) ? '&' : '?';
  
  let authUrl: string;
  authUrl = url + firstParamAppender;

  url = url +
    firstParamAppender +
    'lang=' + lang +
    '&key=' + key +
    '&requestingAppId=' + requestingAppId;
  
  if (effectiveReturnURL != null)
    url += '&returnURL=' + encodeURIComponent(effectiveReturnURL);

  url +=
    '&domain=' + domain +
    '&registerURL=' + encodeURIComponent(info.register); 
  
  url += '&poll=' + encodeURIComponent(pollURL);
  
  const cleanOauthState = (typeof oauthState) === 'string' ?
    oauthState : 
    null; 

  if (cleanOauthState != null) 
    url += '&oauthState=' + cleanOauthState;

    /**
     * this should be poll instead of pollUrl (as in accessState)
     */
  authUrl += '&pollUrl=' + encodeURIComponent(pollURL);

  const accessState: AccessState = {
    status: 'NEED_SIGNIN',
    code: 201,
    key: key,
    requestingAppId: requestingAppId,
    requestedPermissions: requestedPermissions,
    url: url,
    authUrl: authUrl,
    poll: pollURL,
    returnURL: effectiveReturnURL,
    oauthState: cleanOauthState,
    poll_rate_ms: 1000,
    clientData: clientData,
    lang: lang,
    serviceInfo: serviceInfo,
    deviceName: deviceName,
    expireAfter: expireAfter,
    referer: referer,
  };

  accessLib.setAccessState(key, accessState, successHandler, errorHandler);
};

function isAuthURLValid(url: string): boolean {
  return checkAndConstraints.url(url);
}

const trustedAuthUrls = config.get('access:trustedAuthUrls');
trustedAuthUrls.push(config.get('access:defaultAuthUrl'));

function isAuthDomainTrusted(url: string) {
  
  for(let i = 0; i < trustedAuthUrls.length; i++) {
    if(url.startsWith(trustedAuthUrls[i])) {
      return true;
    }
  }
  return false;
}

function isServiceInfoValid(serviceInfo: mixed): boolean {
  return serviceInfo && serviceInfo.name ? true : false;
}

/// Check the validity of the access by checking its associated key.
/// 
accessLib.testKeyAndGetValue = function (
  key: string, 
  success: (res: AccessState) => mixed, 
  failed: (err: Error) => mixed, 
) {
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
 * @returns {string}: the generated key
 */
function randGenerator(stringLength) {
  var chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXTZabcdefghiklmnopqrstuvwxyz';
  var randomstring = '';
  for (var i=0; i<stringLength; i++) {
    randomstring += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return randomstring;
}