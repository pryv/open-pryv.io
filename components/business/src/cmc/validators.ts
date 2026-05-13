/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Plan 68 — content validators for cmc/* event types.
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

type ValidationResult = { valid: boolean; errors: string[] };

const PERMISSION_LEVELS = new Set(['manage', 'contribute', 'read', 'create-only', 'none']);
const SYSTEM_ALERT_LEVELS = new Set(['info', 'warning', 'critical']);

function ok (): ValidationResult {
  return { valid: true, errors: [] };
}

function fail (...errors: string[]): ValidationResult {
  return { valid: false, errors };
}

function isPlainObject (v: any): boolean {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function isLocalizableText (v: any): boolean {
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

function isPermissionArray (v: any): { ok: boolean; reason?: string } {
  if (!Array.isArray(v)) return { ok: false, reason: 'must be an array' };
  if (v.length === 0) return { ok: false, reason: 'must not be empty' };
  for (let i = 0; i < v.length; i++) {
    const p = v[i];
    if (!isPlainObject(p)) return { ok: false, reason: `entry ${i} must be an object` };
    if (typeof p.streamId !== 'string' || p.streamId.length === 0) {
      return { ok: false, reason: `entry ${i}: streamId must be a non-empty string` };
    }
    if (typeof p.level !== 'string' || !PERMISSION_LEVELS.has(p.level)) {
      return {
        ok: false,
        reason: `entry ${i}: level must be one of ${[...PERMISSION_LEVELS].join(', ')}`,
      };
    }
  }
  return { ok: true };
}

function checkLocalizable (errors: string[], path: string, v: any, optional = false): void {
  if (v == null) {
    if (!optional) errors.push(`${path}: required`);
    return;
  }
  if (!isLocalizableText(v)) {
    errors.push(`${path}: must be a localizable-text object (lang→string map, non-empty)`);
  }
}

// --- Per-event-type validators ---

function validateRequest (content: any): ValidationResult {
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

function validateAccept (content: any): ValidationResult {
  if (!isPlainObject(content)) return fail('content must be an object');
  const errors: string[] = [];

  if (typeof content.capabilityUrl !== 'string' || content.capabilityUrl.length === 0) {
    errors.push('content.capabilityUrl: required, must be a non-empty string');
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

  return errors.length === 0 ? ok() : fail(...errors);
}

function validateRefuse (content: any): ValidationResult {
  if (!isPlainObject(content)) return fail('content must be an object');
  const errors: string[] = [];

  if (typeof content.capabilityUrl !== 'string' || content.capabilityUrl.length === 0) {
    errors.push('content.capabilityUrl: required, must be a non-empty string');
  }

  if (content.reason != null) checkLocalizable(errors, 'content.reason', content.reason, true);

  return errors.length === 0 ? ok() : fail(...errors);
}

function validateRevoke (content: any): ValidationResult {
  if (!isPlainObject(content)) return fail('content must be an object');
  const errors: string[] = [];

  if (typeof content.accessId !== 'string' || content.accessId.length === 0) {
    errors.push('content.accessId: required, must be a non-empty string');
  }

  if (content.reason != null) checkLocalizable(errors, 'content.reason', content.reason, true);

  return errors.length === 0 ? ok() : fail(...errors);
}

function validateChat (content: any): ValidationResult {
  if (!isPlainObject(content)) return fail('content must be an object');
  const errors: string[] = [];

  if (typeof content.content !== 'string' || content.content.length === 0) {
    errors.push('content.content: required, must be a non-empty string');
  } else if (content.content.length > 10 * 1024) {
    errors.push('content.content: must be ≤ 10 KB');
  }

  return errors.length === 0 ? ok() : fail(...errors);
}

function validateSystemAlert (content: any): ValidationResult {
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

function validateSystemAck (content: any): ValidationResult {
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

function validateSystemScopeRequest (content: any): ValidationResult {
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

function validateSystemScopeUpdate (content: any): ValidationResult {
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

const VALIDATORS: { [k: string]: (content: any) => ValidationResult } = {
  [C.ET_REQUEST]: validateRequest,
  [C.ET_ACCEPT]: validateAccept,
  [C.ET_REFUSE]: validateRefuse,
  [C.ET_REVOKE]: validateRevoke,
  [C.ET_CHAT]: validateChat,
  [C.ET_SYSTEM_ALERT]: validateSystemAlert,
  [C.ET_SYSTEM_ACK]: validateSystemAck,
  [C.ET_SYSTEM_SCOPE_REQUEST]: validateSystemScopeRequest,
  [C.ET_SYSTEM_SCOPE_UPDATE]: validateSystemScopeUpdate,
};

function isKnownEventType (eventType: string): boolean {
  return Object.prototype.hasOwnProperty.call(VALIDATORS, eventType);
}

function validate (eventType: string, content: any): ValidationResult {
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
};
