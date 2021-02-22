/**
 * @license
 * Copyright (C) 2020-2021 Pryv S.A. https://pryv.com 
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
  'DISABLED_METHOD' : {'message' : 'The action you are trying to execute has been disabled. Please contact the platform admin to activate it.',
    'detail' : ''
  }
};

if (module && module.exports) {
  module.exports = messages;
} else if (window) {
  // temp HACK (make linting pass without changing behavior)
  window.register_messages = messages;
}
