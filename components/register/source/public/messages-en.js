/**
 * @license
 * Copyright (C) 2020 Pryv S.A. https://pryv.com - All Rights Reserved
 * Unauthorized copying of this file, via any medium is strictly prohibited
 * Proprietary and confidential
 */
/*global window*/

var messages = {
  'INTERNAL_ERROR' : {'message' : 'Internal Error',
    'detail' : 'Something went bad on our side, sorry for this inconvenience.'},
  'INVALID_DATA' : {'message' : 'Invalid Data',
    'detail' : 'Some of the data transmited is invalid.'},
  'INVALID_JSON_REQUEST' : {'message' : 'Invalid Data',
    'detail' : 'The data transmited is not in a valid JSON format.'},
  'INVALID_USER_NAME' : { 'message' : 'Invalid user name',
    'detail' : 'User name must be made of 5 to 23 alphanumeric characters (- authorized).'},
  'INVALID_API_ENDPOINT': {
    'message': 'Invalid api endpoint',
    'detail': 'api endpoint should be a valid url'
  },
  'RESERVED_USER_NAME' : { 'message' : 'Reserved user name',
    'detail' : 'User name is reserved.'},
  'EXISTING_USER_NAME' : { 'message' : 'Username already exists',
    'detail' : 'User name must be unique.'},
  'INVALID_PASSWORD' : { 'message' : 'Invalid password',
    'detail' : 'Password must be between 6 and 99 characters.'},

  'INVALID_APPID' : { 'message' : 'Invalid app id',
    'detail' : 'App id is not recognized'},
  'INVALID_INVITATION' : { 'message' : 'Invalid invitation token',
    'detail' : 'Request one from pryv'},

  'INVALID_HOSTING' : { 'message' : 'Invalid hosting',
    'detail' : 'Hosting value must be made of 4 to 70 alphanumeric characters (- and . authorized).'},

  'UNAVAILABLE_HOSTING' : { 'message' : 'Hosting not available',
    'detail' : 'Hosting unknown, not active or unavailable, retry with another one'},

  'INVALID_LANGUAGE': { 'message' : 'Invalid language code',
    'detail' : 'Language code should be a string of 1-5 characters.' },

  'INVALID_EMAIL' : { 'message' : 'Invalid email address',
    'detail' : 'E-mail address format not recognized'},
  'EXISTING_EMAIL' : { 'message' : 'E-mail already exists',
      'detail' : 'This e-mail is already assigned to a user.'},

  'USER_CREATED' : { 'message' : 'Registration started',
    'detail' : 'An e-mail has been sent, please check your mailbox to confirm your registration.'},

  'ALREADY_CONFIRMED' : { 'message' : 'Already confirmed',
    'detail' : 'The registration for this user has already been confirmed.'},
  'NO_PENDING_CREATION' : { 'message' : 'No pending creation',
    'detail' : 'User unknown or creation time elapsed.'},
  'INVALID_CHALLENGE' : { 'message' : 'Invalid challenge',
    'detail' : 'Data format of the challenge is not recognized.'},

  'UNKNOWN_USER_NAME' : { 'message' : 'Unknown user name',
    'detail' : ''},
  'UNKNOWN_EMAIL' : { 'message' : 'Unknown e-mail',
      'detail' : ''},

  'INVALID_KEY' : { 'message' : 'Invalid access request key',
      'detail' : ''},
  'INVALID_APP_ID' : { 'message' : 'Invalid app ID',
        'detail' : ''},
  'UNTRUSTED_AUTH_URL' : { 'message' : 'Authentication URL should be on the same domain',
      'detail' : ''},
  'INVALID_AUTH_URL' : { 'message' : 'Authentication URL is invalid',
      'detail' : ''},
  'INVALID_SERVICE_INFO_URL' : { 'message' : 'Service information URL is invalid',
      'detail' : ''},
  'INVALID_DEVICE_NAME' : { 'message' : 'Device name is invalid',
    'detail' : ''},
  'INVALID_EXPIRE_AFTER' : { 'message' : 'ExpireAfter is invalid',
    'detail' : ''},
  'INVALID_REFERER' : { 'message' : 'referer is invalid',
    'detail' : ''},
};

if (module && module.exports) {
  module.exports = messages;
} else if (window) {
  // temp HACK (make linting pass without changing behavior)
  window.register_messages = messages;
}
