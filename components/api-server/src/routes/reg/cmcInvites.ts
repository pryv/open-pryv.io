/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Consent invites carried by an access request (`cmcInvites`).
 *
 * An app may ask, in the same authorisation request, that the user also
 * answers one or more cross-account messaging invites (capability URLs it
 * received from a requester). The auth page shows each invite next to the
 * app access, accepts or declines it, and posts one outcome per invite with
 * ACCEPTED. This module validates both shapes; the core stores them and hands
 * them back, it never acts on them.
 *
 * The outcomes are a hint, like `delegation`: the requester learns the truth
 * from its own inbox (`consent/accept-cmc`), and `mandatory` is enforced by
 * the trusted auth page (a declined mandatory invite ends the request
 * REFUSED with `reasonId: 'REFUSED_MANDATORY_CONSENT'`), not re-verified here.
 */

/** At most this many invites in one request. */
const MAX_INVITES = 8;
/** Longest capability URL accepted, in characters. */
const MAX_URL_LENGTH = 2048;
/** Longest id or reason string in an outcome. */
const MAX_FIELD_LENGTH = 256;

type CmcInvite = { capabilityUrl: string; mandatory: boolean; for: 'self' | 'target' };
type CmcInviteAccepted = { acceptEventId: string; dataGrantAccessId?: string; acceptedFor?: 'self' };
type CmcInviteOutcome = CmcInviteAccepted | { declined: true } | { reason: string };

function isPlainObject (value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedString (value: unknown, max: number): value is string {
  return typeof value === 'string' && value !== '' && value.length <= max;
}

function isHttpUrl (value: string): boolean {
  // The URL parser strips tabs and newlines before validating; refuse any
  // control character or space up front so what is stored is what was checked.
  if (/[\u0000- \u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * The `cmcInvites` of a new access request, as a clean copy (`mandatory`
 * defaults to false, `for` to `'self'`), or an error message.
 */
function parseCmcInvites (value: unknown): CmcInvite[] | string {
  const message = 'cmcInvites must be an array of 1 to ' + MAX_INVITES +
    " { capabilityUrl, mandatory?, for?: 'self' | 'target' }";
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_INVITES) return message;
  const clean: CmcInvite[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) return message;
    if (Object.keys(entry).some((k) => !['capabilityUrl', 'mandatory', 'for'].includes(k))) return message;
    if (!isBoundedString(entry.capabilityUrl, MAX_URL_LENGTH) || !isHttpUrl(entry.capabilityUrl)) {
      return 'cmcInvites[].capabilityUrl must be an absolute http(s) URL of at most ' + MAX_URL_LENGTH + ' characters';
    }
    if (entry.mandatory !== undefined && typeof entry.mandatory !== 'boolean') return message;
    if (entry.for !== undefined && entry.for !== 'self' && entry.for !== 'target') return message;
    clean.push({
      capabilityUrl: entry.capabilityUrl,
      mandatory: entry.mandatory === true,
      for: entry.for === 'target' ? 'target' : 'self'
    });
  }
  return clean;
}

/**
 * The `cmcInvites` outcomes an auth page posts with ACCEPTED, one per invite
 * of the request and in its order, as a clean copy, or an error message.
 * Each is `{ acceptEventId, dataGrantAccessId?, acceptedFor?: 'self' }`,
 * `{ declined: true }` or `{ reason }`.
 */
function parseCmcInviteOutcomes (value: unknown, requested: unknown): CmcInviteOutcome[] | string {
  if (!Array.isArray(requested)) return 'cmcInvites outcomes are only valid when the request carried cmcInvites';
  const message = 'cmcInvites must hold one outcome per invite of the request: ' +
    "{ acceptEventId, dataGrantAccessId?, acceptedFor?: 'self' } | { declined: true } | { reason }";
  if (!Array.isArray(value) || value.length !== requested.length) return message;
  const clean: CmcInviteOutcome[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) return message;
    const keys = Object.keys(entry);
    if (keys.includes('acceptEventId')) {
      if (keys.some((k) => !['acceptEventId', 'dataGrantAccessId', 'acceptedFor'].includes(k))) return message;
      if (!isBoundedString(entry.acceptEventId, MAX_FIELD_LENGTH)) return message;
      if (entry.dataGrantAccessId !== undefined && !isBoundedString(entry.dataGrantAccessId, MAX_FIELD_LENGTH)) return message;
      if (entry.acceptedFor !== undefined && entry.acceptedFor !== 'self') return message;
      const accepted: CmcInviteAccepted = { acceptEventId: entry.acceptEventId };
      if (entry.dataGrantAccessId !== undefined) accepted.dataGrantAccessId = entry.dataGrantAccessId as string;
      if (entry.acceptedFor === 'self') accepted.acceptedFor = 'self';
      clean.push(accepted);
    } else if (keys.includes('declined')) {
      if (keys.length !== 1 || entry.declined !== true) return message;
      clean.push({ declined: true });
    } else if (keys.includes('reason')) {
      if (keys.length !== 1 || !isBoundedString(entry.reason, MAX_FIELD_LENGTH)) return message;
      clean.push({ reason: entry.reason });
    } else {
      return message;
    }
  }
  return clean;
}

export { parseCmcInvites, parseCmcInviteOutcomes, MAX_INVITES };
export type { CmcInvite, CmcInviteOutcome };
