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

/**
 * Encryption helper functions (wraps bcrypt functionality for hashing).
 */

type Callback = (err?: ?Error, value: mixed) => void;

var bcrypt = require('bcrypt'),
    crypto = require('crypto');

var salt = bcrypt.genSaltSync(process.env.NODE_ENV === 'development' ? 1 : 10);

/**
 * @param {String} value The value to be hashed.
 * @param {Function} callback (error, hash)
 */
exports.hash = function (value: string, callback: Callback) {
  bcrypt.hash(value, salt, callback);
};

/**
 * For tests only.
 */
exports.hashSync = function (value: string): string {
  return bcrypt.hashSync(value, salt);
};

/**
 * @param {String} value The value to check
 * @param {String} hash The hash to check the value against
 * @param {Function} callback (error, {Boolean} result)
 */
exports.compare = function (value: string, hash: string, callback: Callback) {
  bcrypt.compare(value, hash, callback);
};

/**
 * Computes the given file's read token for the given access and server secret.
 *
 * @param {String} fileId
 * @param {Object} access
 * @param {String} secret
 * @returns {string}
 */
exports.fileReadToken = function(
  fileId: string, 
  accessId: string, accessToken: string, 
  secret: string) 
{
  return accessId + '-' + getFileHMAC(fileId, accessToken, secret);
};

/**
 * Extracts the parts from the given file read token.
 *
 * @param {String} fileReadToken
 * @returns {Object} Contains `accessId` and `hmac` parts if successful; empty otherwise.
 */
exports.parseFileReadToken = function (fileReadToken: string) {
  var sepIndex = fileReadToken.indexOf('-');
  if (sepIndex <= 0) { return {}; }
  return {
    accessId: fileReadToken.substr(0, sepIndex),
    hmac: fileReadToken.substr(sepIndex + 1)
  };
};

exports.isFileReadTokenHMACValid = function (
  hmac: string, fileId: string, token: string, 
  secret: string) 
{
  return hmac === getFileHMAC(fileId, token, secret);
};

function getFileHMAC(fileId, token, secret): string {
  var hmac = crypto.createHmac('sha1', secret);
  hmac.setEncoding('base64');
  hmac.write(fileId + '-' + token);
  hmac.end();
  
  const base64HMAC = hmac.read();
  if (base64HMAC == null) throw new Error('AF: HMAC cannot be null');
  
  return base64HMAC
    .toString()   // function signature says we might have a buffer here.
    .replace(/\//g, '_').replace(/\+/g, '-').replace(/=/g, '');
}
