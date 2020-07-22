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
