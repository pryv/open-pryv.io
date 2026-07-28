/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

/**
 * The telemetry allow-list: the single definition of everything that may
 * ever leave this process.
 *
 * This module is the whole data-protection argument. Telemetry is not
 * observed by a third party and then filtered; it is CONSTRUCTED here from
 * a closed vocabulary. A field that is not named below cannot be emitted,
 * so the question "could a username / URL / header / message body reach the
 * backend?" is answered by reading this file rather than by auditing the
 * behaviour of an external agent.
 *
 * Rules for editing:
 *   - Values are enums or numbers. Never free text, never anything derived
 *     from a request, a payload, a config value or a hostname the operator
 *     does not control.
 *   - Adding a metric, an attribute key or an enum value is a
 *     data-protection change: it needs the three-layer proof (constants
 *     pinned by tests, filter decision asserted, wire enumeration).
 */

/** Metric names. Nothing else may be emitted as a metric. */
const METRICS = {
  CALLS: 'api.method.calls',
  DURATION: 'api.method.duration',
  ERRORS: 'api.method.errors',
  DROPPED: 'telemetry.dropped'
} as const;

/** Attribute keys, per metric. Anything else is dropped. */
const METRIC_ATTRIBUTES: Record<string, readonly string[]> = {
  [METRICS.CALLS]: ['method.id', 'status.class'],
  [METRICS.DURATION]: ['method.id', 'status.class'],
  [METRICS.ERRORS]: ['method.id', 'error.code'],
  [METRICS.DROPPED]: ['reason']
};

/** Attribute keys allowed on an error report. */
const ERROR_ATTRIBUTES: readonly string[] = ['method.id', 'error.code', 'error.class'];

/** Closed enums for every attribute whose values are not open-ended. */
const STATUS_CLASSES: readonly string[] = ['2xx', '3xx', '4xx', '5xx'];

/**
 * Reasons a payload can be dropped. Reported as `telemetry.dropped` so a
 * schema violation is visible as a number rather than as silence.
 */
const DROP_REASONS = {
  UNKNOWN_METRIC: 'unknown-metric',
  UNKNOWN_ATTRIBUTE: 'unknown-attribute',
  UNKNOWN_METHOD_ID: 'unknown-method-id',
  INVALID_STATUS_CLASS: 'invalid-status-class',
  UNKNOWN_ERROR_CODE: 'unknown-error-code',
  INVALID_VALUE: 'invalid-value',
  BUFFER_FULL: 'buffer-full',
  SEND_FAILED: 'send-failed'
} as const;

/** Resource attribute keys (process identity; no request-derived data). */
const RESOURCE_ATTRIBUTES: readonly string[] = [
  'service.name',
  'service.version',
  'service.instance.id',
  'service.worker'
];

/**
 * The method-id vocabulary, registered at startup from the API method
 * registry (`API.getMethodKeys()`), i.e. from identifiers declared in our
 * own source. Membership is checked on every emit, so a caller that passes
 * a runtime string instead of a registered id gets dropped and counted
 * rather than forwarded. Empty until registered.
 */
let allowedMethodIds: Set<string> = new Set();

function registerMethodIds (ids: Iterable<string>): void {
  allowedMethodIds = new Set(ids);
}

function knownMethodIds (): Set<string> {
  return allowedMethodIds;
}

/**
 * The error-code vocabulary, registered at startup from `ErrorIds` plus the
 * `unknown` fallback. Same contract as method ids.
 */
let allowedErrorCodes: Set<string> = new Set();

function registerErrorCodes (codes: Iterable<string>): void {
  allowedErrorCodes = new Set(codes);
}

function knownErrorCodes (): Set<string> {
  return allowedErrorCodes;
}

/** Test-only: clear registered vocabularies. */
function _resetVocabularies (): void {
  allowedMethodIds = new Set();
  allowedErrorCodes = new Set();
}

type ValidationResult = { ok: true } | { ok: false, reason: string };

const OK: ValidationResult = { ok: true };

/**
 * Validate one metric datapoint against the allow-list. Returns the drop
 * reason instead of throwing: telemetry must never break a request.
 */
function validateMetric (name: string, attributes: Record<string, string>, value: number): ValidationResult {
  const allowedKeys = METRIC_ATTRIBUTES[name];
  if (allowedKeys == null) return { ok: false, reason: DROP_REASONS.UNKNOWN_METRIC };
  if (!Number.isFinite(value)) return { ok: false, reason: DROP_REASONS.INVALID_VALUE };
  for (const key of Object.keys(attributes)) {
    if (!allowedKeys.includes(key)) return { ok: false, reason: DROP_REASONS.UNKNOWN_ATTRIBUTE };
    const attrResult = validateAttribute(key, attributes[key]);
    if (!attrResult.ok) return attrResult;
  }
  return OK;
}

/** Validate one error report's attributes against the allow-list. */
function validateErrorAttributes (attributes: Record<string, string>): ValidationResult {
  for (const key of Object.keys(attributes)) {
    if (!ERROR_ATTRIBUTES.includes(key)) return { ok: false, reason: DROP_REASONS.UNKNOWN_ATTRIBUTE };
    const attrResult = validateAttribute(key, attributes[key]);
    if (!attrResult.ok) return attrResult;
  }
  return OK;
}

/**
 * Per-key value check. Every allowed key is either a closed enum or a
 * registered vocabulary; `error.class` is the one constructor-name field
 * and is pattern-bounded (a JS identifier cannot carry a path or a
 * sentence).
 */
function validateAttribute (key: string, value: string): ValidationResult {
  if (typeof value !== 'string') return { ok: false, reason: DROP_REASONS.INVALID_VALUE };
  switch (key) {
    case 'method.id':
      return allowedMethodIds.has(value) ? OK : { ok: false, reason: DROP_REASONS.UNKNOWN_METHOD_ID };
    case 'status.class':
      return STATUS_CLASSES.includes(value) ? OK : { ok: false, reason: DROP_REASONS.INVALID_STATUS_CLASS };
    case 'error.code':
      return allowedErrorCodes.has(value) ? OK : { ok: false, reason: DROP_REASONS.UNKNOWN_ERROR_CODE };
    case 'error.class':
      return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? OK : { ok: false, reason: DROP_REASONS.INVALID_VALUE };
    case 'reason':
      return Object.values(DROP_REASONS).includes(value as never)
        ? OK
        : { ok: false, reason: DROP_REASONS.INVALID_VALUE };
    default:
      return { ok: false, reason: DROP_REASONS.UNKNOWN_ATTRIBUTE };
  }
}

export {
  METRICS,
  METRIC_ATTRIBUTES,
  ERROR_ATTRIBUTES,
  STATUS_CLASSES,
  DROP_REASONS,
  RESOURCE_ATTRIBUTES,
  registerMethodIds,
  knownMethodIds,
  registerErrorCodes,
  knownErrorCodes,
  validateMetric,
  validateErrorAttributes,
  validateAttribute,
  _resetVocabularies
};
export type { ValidationResult };
