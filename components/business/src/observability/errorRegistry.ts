/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Classify a failure into the closed vocabulary the emitter accepts.
 *
 * The registry is `ErrorIds` — the API's own identifier constants — plus
 * `unknown` for anything unrecognised. Reusing it means the emitted codes
 * are exactly the codes the API already documents, and that no new list
 * has to be kept in sync.
 *
 * Two distinct questions live here:
 *   - what CODE does this failure carry (every failure gets one, and is
 *     counted with it);
 *   - is it worth a REPORT with a stack (only server-side faults are:
 *     a rejected token or an unknown resource is the client's business,
 *     arrives in volume, and its stack points at our validation code
 *     rather than at a defect).
 */

const { ErrorIds } = require('errors/src/ErrorIds.ts');
const { ErrorMessages } = require('errors/src/ErrorMessages.ts');

const UNKNOWN_CODE = 'unknown';

/**
 * The hard-coded message list. A report's human-readable text is looked
 * up here by code and is therefore a compile-time constant of this
 * repository, identical on every deployment. The thrown error's own
 * message is never consulted.
 */
const FALLBACK_MESSAGES: Record<string, string> = {
  [UNKNOWN_CODE]: 'Unclassified server error'
};

/**
 * @param code — a registry code (see `allErrorCodes`).
 * @returns the hard-coded message for that code.
 */
function messageFor (code: string): string {
  const message = ErrorMessages[code] ?? FALLBACK_MESSAGES[code];
  if (typeof message === 'string' && message.length > 0 && message.length <= 200) return message;
  // Codes without a catalogue entry report the code itself, which is
  // also a compile-time constant.
  return code;
}

/** Every value of ErrorIds, plus the fallback. The emitter's vocabulary. */
function allErrorCodes (): string[] {
  const ids = Object.values(ErrorIds) as string[];
  return ids.filter(function (id) { return typeof id === 'string'; }).concat([UNKNOWN_CODE]);
}

let knownCodes: Set<string> | null = null;

function codeSet (): Set<string> {
  if (knownCodes == null) knownCodes = new Set(allErrorCodes());
  return knownCodes;
}

/**
 * Codes that always deserve a stack even though their HTTP status may not
 * be 5xx: they signal a fault on our side rather than a bad request.
 */
const ALWAYS_REPORTED: readonly string[] = ['unexpected-error', 'corrupted-data', 'api-unavailable'];

interface ErrorClassification {
  code: string;
  statusClass: string;
  reportable: boolean;
}

/**
 * @param err — the error an API call failed with.
 */
function classify (err: unknown): ErrorClassification {
  const httpStatus = readNumber(err, 'httpStatus');
  const rawId = readString(err, 'id');
  const code = (rawId != null && codeSet().has(rawId)) ? rawId : UNKNOWN_CODE;
  const statusClass = statusClassOf(httpStatus);
  const reportable = statusClass === '5xx' || ALWAYS_REPORTED.includes(code) || code === UNKNOWN_CODE;
  return { code, statusClass, reportable };
}

/**
 * An error with no usable status is treated as a server fault: an
 * unclassifiable failure is exactly the case worth seeing.
 */
function statusClassOf (httpStatus: number | null): string {
  if (httpStatus == null || !Number.isFinite(httpStatus)) return '5xx';
  if (httpStatus >= 500) return '5xx';
  if (httpStatus >= 400) return '4xx';
  if (httpStatus >= 300) return '3xx';
  if (httpStatus >= 200) return '2xx';
  return '5xx';
}

function readString (obj: unknown, key: string): string | null {
  if (obj == null || typeof obj !== 'object') return null;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function readNumber (obj: unknown, key: string): number | null {
  if (obj == null || typeof obj !== 'object') return null;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : null;
}

export { classify, allErrorCodes, statusClassOf, messageFor, UNKNOWN_CODE, ALWAYS_REPORTED };
export type { ErrorClassification };
