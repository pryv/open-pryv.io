/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { randomInt } from 'node:crypto';

/** Code lengths accepted (digits). */
const MIN_CODE_LENGTH = 4;
const MAX_CODE_LENGTH = 10;

/**
 * A numeric code of `codeLength` digits, drawn uniformly from 0 to
 * 10^codeLength - 1 (leading zeroes kept), from the CSPRNG.
 */
async function generateCode (codeLength: number): Promise<string> {
  if (!Number.isInteger(codeLength) || codeLength < MIN_CODE_LENGTH || codeLength > MAX_CODE_LENGTH) {
    throw new Error(`MFA code length must be an integer from ${MIN_CODE_LENGTH} to ${MAX_CODE_LENGTH}, got ${codeLength}`);
  }
  return String(randomInt(0, 10 ** codeLength)).padStart(codeLength, '0');
}

export default generateCode;
export { generateCode, MIN_CODE_LENGTH, MAX_CODE_LENGTH };
