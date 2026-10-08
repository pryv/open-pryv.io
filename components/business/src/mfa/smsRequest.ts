/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { factory as errors } from 'errors';

/**
 * What reaches an SMS provider request, and how.
 *
 * Inputs: an MFA code must be 4 to 10 digits; the SMS enrolment content is
 * `phone` (E.164) plus the keys the operator allow-lists in
 * `services.mfa.methods.sms.contentKeys`, each a string, capped in total size.
 *
 * Rendering: the operator's endpoint templates carry `{{ key }}` placeholders.
 * They are substituted in ONE pass over each template, so a substituted value
 * is never scanned again (a value containing `{{ code }}` stays literal), and
 * each value is encoded for where it lands:
 *  - URL: `encodeURIComponent`;
 *  - headers: the value is refused (error, nothing sent) when it holds a
 *    character outside printable ASCII, CR and LF included;
 *  - string body: form-encoded (`encodeURIComponent`) when the endpoint
 *    declares `content-type: application/x-www-form-urlencoded`; escaped as
 *    the content of a JSON string when the endpoint declares a JSON content
 *    type, or when the template itself is JSON text (placeholders sit inside
 *    its string literals); inserted as is otherwise (plain text);
 *  - object body: substituted on string leaves, unencoded, since the whole
 *    object is serialized to JSON when sent.
 * A placeholder with no value is left as written.
 */

const CODE_PATTERN = /^[0-9]{4,10}$/;
const PHONE_PATTERN = /^\+[1-9][0-9]{6,14}$/;
/** Serialized (JSON) size cap of an SMS enrolment content. */
const CONTENT_MAX_BYTES = 256;
/** Activate-body keys that are never enrolment content. */
const NON_CONTENT_KEYS = ['method', 'password', 'code'];
/** Names an operator may not allow-list as content keys. */
const RESERVED_CONTENT_KEYS = [...NON_CONTENT_KEYS, 'phone'];

const PLACEHOLDER = /\{\{ ([^{}]+?) \}\}/g;
const HEADER_VALUE_SAFE = /^[\x20-\x7e]*$/;

type Values = Record<string, string>;

function isValidCode (code: unknown): code is string {
  return typeof code === 'string' && CODE_PATTERN.test(code);
}

function invalidCodeError (): Error {
  return errors.invalidParametersFormat('The provided MFA code is invalid.', { id: 'invalid-mfa-code' });
}

/**
 * The SMS enrolment content of an activate body (step-up and method fields
 * excluded), validated. Throws `invalid-parameters-format` (400) otherwise.
 */
function smsEnrolmentContent (params: Record<string, unknown>, allowedKeys: readonly string[]): Record<string, string> {
  const content: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (NON_CONTENT_KEYS.includes(key)) continue;
    if (key !== 'phone' && !allowedKeys.includes(key)) {
      throw errors.invalidParametersFormat(`Unexpected SMS enrolment parameter "${key}".`, { id: 'invalid-mfa-content' });
    }
    if (typeof value !== 'string') {
      throw errors.invalidParametersFormat(`SMS enrolment parameter "${key}" must be a string.`, { id: 'invalid-mfa-content' });
    }
    content[key] = value;
  }
  if (typeof content.phone !== 'string' || !PHONE_PATTERN.test(content.phone)) {
    throw errors.invalidParametersFormat('"phone" is required, in E.164 format (e.g. +41791234567).', { id: 'invalid-mfa-content' });
  }
  if (Buffer.byteLength(JSON.stringify(content), 'utf8') > CONTENT_MAX_BYTES) {
    throw errors.invalidParametersFormat(`The SMS enrolment parameters exceed ${CONTENT_MAX_BYTES} bytes.`, { id: 'invalid-mfa-content' });
  }
  return content;
}

/** Refuses any activate-body key other than the method and step-up fields. */
function checkNoEnrolmentContent (params: Record<string, unknown>): void {
  for (const key of Object.keys(params)) {
    if (!NON_CONTENT_KEYS.includes(key)) {
      throw errors.invalidParametersFormat(`Unexpected enrolment parameter "${key}".`, { id: 'invalid-mfa-content' });
    }
  }
}

/** Stored content as substitution values (a stored value is stringified). */
function toValues (content: Record<string, unknown> | null | undefined): Values {
  const values: Values = {};
  for (const [key, value] of Object.entries(content || {})) {
    if (value != null) values[key] = String(value);
  }
  return values;
}

/** One pass: each placeholder is replaced once and its value is not rescanned. */
function substitute (template: string, values: Values, encode: (value: string) => string): string {
  return template.replace(PLACEHOLDER, (match: string, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? encode(values[key]) : match);
}

function renderUrl (template: string, values: Values): string {
  if (typeof template !== 'string') return template;
  return substitute(template, values, encodeURIComponent);
}

function headerValue (value: string): string {
  if (!HEADER_VALUE_SAFE.test(value)) {
    throw errors.invalidParametersFormat('An SMS enrolment value cannot be sent in a request header.', { id: 'invalid-mfa-content' });
  }
  return value;
}

function renderHeaders (headers: Record<string, unknown> | null | undefined, values: Values): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers || {})) {
    out[name] = typeof value === 'string' ? substitute(value, values, headerValue) : value;
  }
  return out;
}

/** The media type the endpoint headers declare, lowercased, or null. */
function declaredContentType (headers: Record<string, unknown> | null | undefined): string | null {
  for (const [name, value] of Object.entries(headers || {})) {
    if (name.toLowerCase() === 'content-type' && typeof value === 'string') {
      return value.split(';')[0].trim().toLowerCase();
    }
  }
  return null;
}

function isJsonText (text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function jsonStringContent (value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

const raw = (value: string): string => value;

function substituteLeaves (node: unknown, values: Values): unknown {
  if (typeof node === 'string') return substitute(node, values, raw);
  if (Array.isArray(node)) return node.map((item) => substituteLeaves(item, values));
  if (node != null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) out[key] = substituteLeaves(value, values);
    return out;
  }
  return node;
}

/**
 * @param headers - the endpoint's header templates (they declare the body type)
 */
function renderBody (body: unknown, values: Values, headers: Record<string, unknown> | null | undefined): unknown {
  if (body == null) return body;
  if (typeof body !== 'string') return substituteLeaves(body, values);
  const type = declaredContentType(headers);
  if (type === 'application/x-www-form-urlencoded') return substitute(body, values, encodeURIComponent);
  const declaredJson = type != null && (type === 'application/json' || type.endsWith('+json'));
  if (declaredJson || isJsonText(body)) return substitute(body, values, jsonStringContent);
  return substitute(body, values, raw);
}

type EndpointTemplate = { url: string; headers: Record<string, unknown>; body: unknown };

/** The request for one endpoint: url, headers and body rendered for `values`. */
function renderRequest (endpoint: EndpointTemplate, values: Values): { url: string; headers: Record<string, unknown>; body: unknown } {
  return {
    url: renderUrl(endpoint.url, values),
    headers: renderHeaders(endpoint.headers, values),
    body: renderBody(endpoint.body, values, endpoint.headers)
  };
}

/**
 * Challenge-verify: what makes a provider's 2xx answer to a verify request a
 * success. With a predicate `{ jsonPath, equals }`, the answer must be JSON and
 * its value at `jsonPath` (dot-separated property names, e.g. `status` or
 * `data.result`) must strictly equal `equals`. Without one, only an empty
 * answer (e.g. 204) is a success: a body the core cannot interpret is never
 * taken for a confirmation.
 */
type SuccessPredicate = { jsonPath: string; equals: string | number | boolean };

const JSON_PATH_PATTERN = /^[^.\s]+(\.[^.\s]+)*$/;

function isValidSuccessPredicate (predicate: unknown): predicate is SuccessPredicate {
  if (predicate == null || typeof predicate !== 'object' || Array.isArray(predicate)) return false;
  const { jsonPath, equals } = predicate as Record<string, unknown>;
  return typeof jsonPath === 'string' && JSON_PATH_PATTERN.test(jsonPath) &&
    ['string', 'number', 'boolean'].includes(typeof equals);
}

/** The value at a dotted path, own properties only; undefined when absent. */
function valueAtPath (root: unknown, jsonPath: string): unknown {
  let node: unknown = root;
  for (const segment of jsonPath.split('.')) {
    if (node == null || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, segment)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/**
 * Whether a verify answer body (of a 2xx response) confirms the code.
 * @param predicate - the endpoint's `success`, or null/undefined when none is configured
 */
function verifyAnswerAccepted (bodyText: string, predicate: unknown): boolean {
  if (predicate == null) return bodyText.trim() === '';
  if (!isValidSuccessPredicate(predicate)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return false;
  }
  return valueAtPath(parsed, predicate.jsonPath) === predicate.equals;
}

export {
  CODE_PATTERN, PHONE_PATTERN, CONTENT_MAX_BYTES, NON_CONTENT_KEYS, RESERVED_CONTENT_KEYS,
  isValidCode, invalidCodeError, smsEnrolmentContent, checkNoEnrolmentContent, toValues,
  renderUrl, renderHeaders, renderBody, renderRequest, declaredContentType,
  isValidSuccessPredicate, valueAtPath, verifyAnswerAccepted
};
export type { SuccessPredicate };
