/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Content validators for cmc/* event types.
 *
 * Each per-type validator returns { valid: boolean, errors: string[] }.
 * `validate(eventType, content)` dispatches by type and is what the
 * events.create write-hook calls.
 *
 * Validators check write-side schema only (what the app writes). Plugin-
 * stamped fields (status, capabilityUrl, content.from, etc.) are NOT
 * validated here — they're added by the plugin after the trigger lands.
 *
 * Kept hand-rolled rather than pulling in a JSON-schema library: the
 * shapes are small and stable, and we want the error messages to be
 * pryv-flavoured (errorId tokens) rather than ajv/z-schema generic.
 */

const C = require('./constants.ts');
// Permission-lexicon single point — validators accept the FULL
// accesses.create grammar (stream AND feature permissions).
const permissionSet = require('business/src/accesses/permissionSet.ts');

type ValidationResult = { valid: boolean; errors: string[] };

const SYSTEM_ALERT_LEVELS = new Set(['info', 'warning', 'critical']);

function ok (): ValidationResult {
  return { valid: true, errors: [] };
}

function fail (...errors: string[]): ValidationResult {
  return { valid: false, errors };
}

function isPlainObject (v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function isLocalizableText (v: unknown): boolean {
  // { en: 'hello', fr: 'bonjour' } — at least one non-empty string value,
  // all keys 2-3 char lowercase, all values strings.
  if (!isPlainObject(v)) return false;
  const entries = Object.entries(v);
  if (entries.length === 0) return false;
  for (const [k, val] of entries) {
    if (typeof k !== 'string' || !/^[a-z]{2,3}$/.test(k)) return false;
    if (typeof val !== 'string') return false;
  }
  return true;
}

function isPermissionArray (v: unknown): { ok: boolean; reason?: string } {
  if (!Array.isArray(v)) return { ok: false, reason: 'must be an array' };
  if (v.length === 0) return { ok: false, reason: 'must not be empty' };
  try {
    permissionSet.normalizePermissions(v);
  } catch (e: unknown) {
    return { ok: false, reason: (e as Error).message };
  }
  return { ok: true };
}

function checkLocalizable (errors: string[], path: string, v: unknown, optional = false): void {
  if (v == null) {
    if (!optional) errors.push(`${path}: required`);
    return;
  }
  if (!isLocalizableText(v)) {
    errors.push(`${path}: must be a localizable-text object (lang→string map, non-empty)`);
  }
}

// --- Per-event-type validators ---

function validateRequest (content: unknown): ValidationResult {
  if (!isPlainObject(content)) return fail('content must be an object');
  const errors: string[] = [];

  // to: required, string-or-null
  if (!(content.to === null || typeof content.to === 'string')) {
    errors.push('content.to: must be a string or null');
  }

  // capabilityRequested: optional, boolean
  if (content.capabilityRequested != null && typeof content.capabilityRequested !== 'boolean') {
    errors.push('content.capabilityRequested: must be a boolean if present');
  }

  // request: required, object with title/description/consent/permissions
  if (!isPlainObject(content.request)) {
    errors.push('content.request: must be an object');
  } else {
    const r = content.request;
    checkLocalizable(errors, 'content.request.title', r.title);
    checkLocalizable(errors, 'content.request.description', r.description);
    checkLocalizable(errors, 'content.request.consent', r.consent);

    const permCheck = isPermissionArray(r.permissions);
    if (!permCheck.ok) errors.push(`content.request.permissions: ${permCheck.reason}`);

    if (r.features != null) {
      if (!isPlainObject(r.features)) {
        errors.push('content.request.features: must be an object if present');
      } else {
        if (r.features.chat != null && typeof r.features.chat !== 'boolean') {
          errors.push('content.request.features.chat: must be a boolean if present');
        }
        if (r.features.systemMessaging != null && typeof r.features.systemMessaging !== 'boolean') {
          errors.push('content.request.features.systemMessaging: must be a boolean if present');
        }
      }
    }

    if (r.expiresAt != null && typeof r.expiresAt !== 'number') {
      errors.push('content.request.expiresAt: must be a number (unix timestamp) if present');
    }
  }

  // requesterMeta: optional, object
  if (content.requesterMeta != null) {
    if (!isPlainObject(content.requesterMeta)) {
      errors.push('content.requesterMeta: must be an object if present');
    } else {
      const m = content.requesterMeta;
      if (m.displayName != null && typeof m.displayName !== 'string') {
        errors.push('content.requesterMeta.displayName: must be a string if present');
      }
      if (m.appId != null && typeof m.appId !== 'string') {
        errors.push('content.requesterMeta.appId: must be a string if present');
      }
      if (m.appUrl != null && typeof m.appUrl !== 'string') {
        errors.push('content.requesterMeta.appUrl: must be a string if present');
      }
    }
  }

  return errors.length === 0 ? ok() : fail(...errors);
}

function validateAccept (content: unknown): ValidationResult {
  if (!isPlainObject(content)) return fail('content must be an object');
  const errors: string[] = [];

  // consent/accept-cmc has TWO shapes:
  //   A. LOCAL TRIGGER  — written by the accepter's app to their own
  //      :_cmc:apps:<app>:* stream to start the accept flow. Required:
  //      capabilityUrl. Optional: accessName, extra.
  //   B. PEER-DELIVERED — written by the accepter's plugin to the
  //      requester's :_cmc:_internal:responses:<capId> stream (via
  //      capability) AND/OR to the requester's :_cmc:inbox (via the
  //      requester's back-channel after accepting). Required:
  //      grantedAccess.apiEndpoint (or content.from for the inbox case).
  //
  // The shape is disambiguated by which fields are present. Strict
  // schema would split this into two event types — kept as one for v1
  // wire-compat. Either shape passes; arbitrary extras outside the
  // two field-sets pass too (the dispatch ignores them).
  const hasCapabilityUrl = typeof content.capabilityUrl === 'string' && content.capabilityUrl.length > 0;
  const hasGrantedAccess = isPlainObject(content.grantedAccess) &&
    typeof content.grantedAccess.apiEndpoint === 'string' &&
    content.grantedAccess.apiEndpoint.length > 0;
  const hasFromOnly = isPlainObject(content.from) &&
    typeof content.from.username === 'string' &&
    typeof content.from.host === 'string';

  if (!hasCapabilityUrl && !hasGrantedAccess && !hasFromOnly) {
    errors.push('content: must carry either capabilityUrl (local trigger) OR grantedAccess.apiEndpoint (peer-delivered)');
  }

  if (content.extra != null) {
    if (!isPlainObject(content.extra)) {
      errors.push('content.extra: must be an object if present');
    } else {
      if (content.extra.chat != null && typeof content.extra.chat !== 'boolean') {
        errors.push('content.extra.chat: must be a boolean if present');
      }
      if (content.extra.systemMessaging != null && typeof content.extra.systemMessaging !== 'boolean') {
        errors.push('content.extra.systemMessaging: must be a boolean if present');
      }
    }
  }

  if (content.accessName != null && typeof content.accessName !== 'string') {
    errors.push('content.accessName: must be a string if present');
  }

  // Optional consent downgrade: the accepter grants only a subset of
  // the offer's permissions. Shape-checked here; the ⊆-offer check
  // happens in handleAccept where the offer is available.
  if (content.grantedPermissions != null) {
    const permCheck = isPermissionArray(content.grantedPermissions);
    if (!permCheck.ok) errors.push(`content.grantedPermissions: ${permCheck.reason}`);
  }

  return errors.length === 0 ? ok() : fail(...errors);
}

function validateRefuse (content: unknown): ValidationResult {
  if (!isPlainObject(content)) return fail('content must be an object');
  const errors: string[] = [];

  if (typeof content.capabilityUrl !== 'string' || content.capabilityUrl.length === 0) {
    errors.push('content.capabilityUrl: required, must be a non-empty string');
  }

  if (content.reason != null) checkLocalizable(errors, 'content.reason', content.reason, true);

  return errors.length === 0 ? ok() : fail(...errors);
}

function validateRevoke (content: unknown): ValidationResult {
  if (!isPlainObject(content)) return fail('content must be an object');
  const errors: string[] = [];

  if (typeof content.accessId !== 'string' || content.accessId.length === 0) {
    errors.push('content.accessId: required, must be a non-empty string');
  }

  if (content.reason != null) checkLocalizable(errors, 'content.reason', content.reason, true);

  return errors.length === 0 ? ok() : fail(...errors);
}

function validateChat (content: unknown): ValidationResult {
  if (!isPlainObject(content)) return fail('content must be an object');
  const errors: string[] = [];

  if (typeof content.content !== 'string' || content.content.length === 0) {
    errors.push('content.content: required, must be a non-empty string');
  } else if (content.content.length > 10 * 1024) {
    errors.push('content.content: must be ≤ 10 KB');
  }

  return errors.length === 0 ? ok() : fail(...errors);
}

function validateSystemAlert (content: unknown): ValidationResult {
  if (!isPlainObject(content)) return fail('content must be an object');
  const errors: string[] = [];

  if (typeof content.level !== 'string' || !SYSTEM_ALERT_LEVELS.has(content.level)) {
    errors.push(
      `content.level: required, must be one of ${[...SYSTEM_ALERT_LEVELS].join(', ')}`
    );
  }

  checkLocalizable(errors, 'content.title', content.title);
  checkLocalizable(errors, 'content.body', content.body);

  if (content.ackRequired != null && typeof content.ackRequired !== 'boolean') {
    errors.push('content.ackRequired: must be a boolean if present');
  }
  if (content.ackId != null && typeof content.ackId !== 'string') {
    errors.push('content.ackId: must be a string if present');
  }

  return errors.length === 0 ? ok() : fail(...errors);
}

function validateSystemAck (content: unknown): ValidationResult {
  if (!isPlainObject(content)) return fail('content must be an object');
  const errors: string[] = [];

  if (typeof content.alertEventId !== 'string' || content.alertEventId.length === 0) {
    errors.push('content.alertEventId: required, must be a non-empty string');
  }
  if (typeof content.ackId !== 'string' || content.ackId.length === 0) {
    errors.push('content.ackId: required, must be a non-empty string');
  }

  return errors.length === 0 ? ok() : fail(...errors);
}

function validateSystemScopeRequest (content: unknown): ValidationResult {
  if (!isPlainObject(content)) return fail('content must be an object');
  const errors: string[] = [];

  const permCheck = isPermissionArray(content.newPermissions);
  if (!permCheck.ok) errors.push(`content.newPermissions: ${permCheck.reason}`);

  if (content.expires != null && typeof content.expires !== 'number') {
    errors.push('content.expires: must be a number (unix timestamp) if present');
  }
  if (content.message != null) checkLocalizable(errors, 'content.message', content.message, true);

  return errors.length === 0 ? ok() : fail(...errors);
}

function validateSystemScopeUpdate (content: unknown): ValidationResult {
  if (!isPlainObject(content)) return fail('content must be an object');
  const errors: string[] = [];

  // Either responds to a request (scopeRequestEventId + accept) OR self-initiated (newPermissions).
  const hasRequestRef = content.scopeRequestEventId != null;
  const hasAccept = content.accept != null;
  const hasNewPerms = content.newPermissions != null;

  if (!hasRequestRef && !hasNewPerms) {
    errors.push(
      'content: must carry either scopeRequestEventId (response-to-request) or newPermissions (self-initiated)'
    );
  }

  if (hasRequestRef && typeof content.scopeRequestEventId !== 'string') {
    errors.push('content.scopeRequestEventId: must be a string if present');
  }
  if (hasAccept && typeof content.accept !== 'boolean') {
    errors.push('content.accept: must be a boolean if present');
  }
  if (hasNewPerms) {
    const permCheck = isPermissionArray(content.newPermissions);
    if (!permCheck.ok) errors.push(`content.newPermissions: ${permCheck.reason}`);
  }

  return errors.length === 0 ? ok() : fail(...errors);
}

// --- Dispatcher ---

function validateBackChannel (raw: unknown): ValidationResult {
  if (!isPlainObject(raw)) {
    return fail('content: must be an object');
  }
  const content = raw;
  const errors: string[] = [];
  const from = content.from as { username?: unknown; host?: unknown } | undefined;
  if (from == null || typeof from.username !== 'string' ||
      typeof from.host !== 'string') {
    errors.push('content.from.{username,host}: required strings');
  }
  if (typeof content.apiEndpoint !== 'string' || (content.apiEndpoint as string).length === 0) {
    errors.push('content.apiEndpoint: required non-empty string');
  }
  // remoteChatStreamId / remoteCollectorStreamId / appCode are optional
  // (older requesters may not send them; the receiver tolerates absence
  // and falls back to whatever was already on the data-grant access).
  return errors.length === 0 ? ok() : fail(...errors);
}

const VALIDATORS: { [k: string]: (content: unknown) => ValidationResult } = {
  [C.ET_REQUEST]: validateRequest,
  [C.ET_ACCEPT]: validateAccept,
  [C.ET_REFUSE]: validateRefuse,
  [C.ET_REVOKE]: validateRevoke,
  [C.ET_CHAT]: validateChat,
  [C.ET_SYSTEM_ALERT]: validateSystemAlert,
  [C.ET_SYSTEM_ACK]: validateSystemAck,
  [C.ET_SYSTEM_SCOPE_REQUEST]: validateSystemScopeRequest,
  [C.ET_SYSTEM_SCOPE_UPDATE]: validateSystemScopeUpdate,
  [C.ET_BACK_CHANNEL]: validateBackChannel,
};

function isKnownEventType (eventType: string): boolean {
  return Object.prototype.hasOwnProperty.call(VALIDATORS, eventType);
}

function validate (eventType: string, content: unknown): ValidationResult {
  if (!isKnownEventType(eventType)) {
    return fail(`unknown cmc event type: ${eventType}`);
  }
  return VALIDATORS[eventType](content);
}

export {
  validate,
  isKnownEventType,
  validateRequest,
  validateAccept,
  validateRefuse,
  validateRevoke,
  validateChat,
  validateSystemAlert,
  validateSystemAck,
  validateSystemScopeRequest,
  validateSystemScopeUpdate,
  validateBackChannel,
};
