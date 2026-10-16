/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The blinded value of an external id: the caller's HMAC of its record id
 * under its own namespace key. Until an account claims it, holding the value
 * is what lets an account claim the id, so it is handled like a secret: never
 * echoed in an error, never logged (use `maskExternalId`), never returned by
 * a listing.
 */

import { factory as errors } from 'errors';

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const MIN_BYTES = 16;
const MAX_BYTES = 64;
// Longest unpadded base64url text of MAX_BYTES bytes: checked before decoding.
const MAX_CHARS = Math.ceil(MAX_BYTES * 4 / 3);

/**
 * Validate a blinded value and return its canonical form (the base64url text
 * of its bytes, so two spellings of the same bytes are one value). `param`
 * names the field in the error, which never contains the value.
 */
export function parseBlindedValue (raw: unknown, param: string = 'blindedValue'): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CHARS || !BASE64URL_RE.test(raw)) {
    throw invalid(param);
  }
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.length < MIN_BYTES || bytes.length > MAX_BYTES) throw invalid(param);
  return bytes.toString('base64url');
}

function invalid (param: string) {
  return errors.invalidParametersFormat(
    `The blinded value must be base64url without padding, ${MIN_BYTES} to ${MAX_BYTES} bytes once decoded.`,
    { param });
}

/** The loggable form of an `externalId` object: the value is replaced. */
export function maskExternalId (externalId: unknown): unknown {
  if (externalId == null || typeof externalId !== 'object') return externalId;
  const masked: Record<string, unknown> = { ...(externalId as Record<string, unknown>) };
  if ('blindedValue' in masked) masked.blindedValue = '***';
  return masked;
}
