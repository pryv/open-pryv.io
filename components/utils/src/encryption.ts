/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Encryption helper functions (wraps bcrypt functionality for hashing).
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const salt = bcrypt.genSaltSync(process.env.NODE_ENV === 'development' ? 1 : 10);

/**
 * @param value The value to be hashed.
 */
async function hash (value: string): Promise<string> {
  return await bcrypt.hash(value, salt);
}

/**
 * For tests only.
 */
function hashSync (value: string): string {
  return bcrypt.hashSync(value, salt);
}

/**
 * @param value The value to check
 * @param hash The hash to check the value against
 */
async function compare (value: string, hash: string): Promise<boolean> {
  return await bcrypt.compare(value, hash);
}

/**
 * Computes the given file's read token for the given access and server secret.
 */
function fileReadToken (fileId: string, accessId: string, accessToken: string, secret: string): string {
  return accessId + '-' + getFileHMAC(fileId, accessToken, secret);
}

/**
 * Extracts the parts from the given file read token.
 */
function parseFileReadToken (fileReadToken: string): { accessId?: string; hmac?: string } {
  const sepIndex = fileReadToken.indexOf('-');
  if (sepIndex <= 0) {
    return {};
  }
  return {
    accessId: fileReadToken.substr(0, sepIndex),
    hmac: fileReadToken.substr(sepIndex + 1)
  };
}

function isFileReadTokenHMACValid (hmac: string, fileId: string, token: string, secret: string): boolean {
  return hmac === getFileHMAC(fileId, token, secret);
}

function getFileHMAC (fileId: string, token: string, secret: string): string {
  const hmac = crypto.createHmac('sha1', secret);
  hmac.setEncoding('base64');
  hmac.write(fileId + '-' + token);
  hmac.end();
  const base64HMAC = hmac.read();
  if (base64HMAC == null) { throw new Error('AF: HMAC cannot be null'); }
  return base64HMAC
    .toString()
    .replace(/\//g, '_')
    .replace(/\+/g, '-')
    .replace(/=/g, '');
}

export { hash, hashSync, compare, fileReadToken, parseFileReadToken, isFileReadTokenHMACValid };
