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
/**
 * Encryption helper functions (wraps bcrypt functionality for hashing).
 */
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const salt = bcrypt.genSaltSync(process.env.NODE_ENV === 'development' ? 1 : 10);
/**
 * @param {String} value The value to be hashed.
 * @returns {String} The hash
 */
exports.hash = async function (value) {
  return await bcrypt.hash(value, salt);
};
/**
 * For tests only.
 */
exports.hashSync = function (value) {
  return bcrypt.hashSync(value, salt);
};
/**
 * @param {String} value The value to check
 * @param {String} hash The hash to check the value against
 * @return {Boolean} True if the value matches the hash
 */
exports.compare = async function (value, hash) {
  return await bcrypt.compare(value, hash);
};
/**
 * Computes the given file's read token for the given access and server secret.
 *
 * @param {String} fileId
 * @param {Object} access
 * @param {String} secret
 * @returns {String}
 */
exports.fileReadToken = function (fileId, accessId, accessToken, secret) {
  return accessId + '-' + getFileHMAC(fileId, accessToken, secret);
};
/**
 * Extracts the parts from the given file read token.
 *
 * @param {String} fileReadToken
 * @returns {Object} Contains `accessId` and `hmac` parts if successful; empty otherwise.
 */
exports.parseFileReadToken = function (fileReadToken) {
  const sepIndex = fileReadToken.indexOf('-');
  if (sepIndex <= 0) {
    return {};
  }
  return {
    accessId: fileReadToken.substr(0, sepIndex),
    hmac: fileReadToken.substr(sepIndex + 1)
  };
};
exports.isFileReadTokenHMACValid = function (hmac, fileId, token, secret) {
  return hmac === getFileHMAC(fileId, token, secret);
};
/**
 * @returns {string}
 */
function getFileHMAC (fileId, token, secret) {
  const hmac = crypto.createHmac('sha1', secret);
  hmac.setEncoding('base64');
  hmac.write(fileId + '-' + token);
  hmac.end();
  const base64HMAC = hmac.read();
  if (base64HMAC == null) { throw new Error('AF: HMAC cannot be null'); }
  return base64HMAC
    .toString() // function signature says we might have a buffer here.
    .replace(/\//g, '_')
    .replace(/\+/g, '-')
    .replace(/=/g, '');
}
