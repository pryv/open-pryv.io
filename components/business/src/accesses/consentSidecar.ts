/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The `consent` sidecar of an auth request, and its resolution into the
 * consent form the rest of the stack already speaks.
 *
 * `POST /reg/access` carries its permissions as PLAIN entries, exactly as
 * it always has, because both auth pages forward those entries verbatim to
 * `accesses.checkApp`, whose schema is `additionalProperties: false`. An
 * annotation written inside an entry would therefore make the user's popup
 * fail against every server and page already deployed. So the annotations
 * travel beside the entries instead, in one optional top-level object:
 *
 *   {
 *     "requestingAppId": "my-app",
 *     "requestedPermissions": [
 *       { "streamId": "diary",  "level": "read" },
 *       { "streamId": "weight", "level": "read" }
 *     ],
 *     "consent": { "allowUserChoice": true, "mandatory": ["diary"], "optIn": ["weight"] }
 *   }
 *
 * An old server ignores the unknown field and the flow degrades to today's
 * all-or-nothing; a new server echoes the resolved form back, which is how
 * an app detects that the annotations were understood.
 *
 * `resolveConsentSidecar` turns the pair into the SAME shape the OAuth2
 * signed state carries, so one consent form, one grant rule
 * (`checkConsentGrant`) and one consent screen serve both flows.
 *
 * Pure module: no config, no I/O. Throws `ConsentSidecarError` on invalid
 * input; the route maps that to `400 invalid-parameters`.
 */

import { normalizePermissions, isStreamPermission } from './permissionSet.ts';

import type { Permission, StreamPermission, FeaturePermission } from '../types/public.ts';

/** A consent-form entry: a plain permission plus at most one annotation. */
type ConsentFormPermission = Permission & { mandatory?: boolean; optIn?: boolean };

/** The resolved form, stored on the access-request state and echoed to the
 * auth page. Identical in shape to the OAuth2 signed state's offer. */
export type ConsentForm = {
  allowUserChoice: boolean;
  permissions: ConsentFormPermission[];
};

/** Invalid sidecar. Carries no status: the caller decides the mapping. */
export class ConsentSidecarError extends Error {
  constructor (message: string) {
    super(message);
    this.name = 'ConsentSidecarError';
  }
}

/**
 * The id an annotation list refers to: a stream permission's `streamId`,
 * a feature permission's `feature`. Deliberately NOT the level or setting:
 * an app names the thing it wants, not the shape of the want.
 */
function entryId (p: Permission): string {
  return isStreamPermission(p)
    ? (p as StreamPermission).streamId
    : (p as FeaturePermission).feature;
}

/** Validate an annotation list and return it as a string array. */
function readIdList (value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ConsentSidecarError(`consent.${field} must be an array of permission ids`);
  }
  for (const id of value) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new ConsentSidecarError(`consent.${field} must contain non-empty permission ids`);
    }
  }
  return value as string[];
}

/**
 * Resolve `requestedPermissions` + the `consent` sidecar into a consent form.
 *
 * Validation (all of it 400 territory, none of it reached when the request
 * carries no sidecar):
 *   - `consent` is an object;
 *   - `allowUserChoice`, when given, is a boolean;
 *   - `mandatory` / `optIn`, when given, are arrays of non-empty strings;
 *   - the permissions themselves pass consent-form normalization, which is
 *     what keeps the `level: 'none'` exclusion-mask guard on this path too;
 *   - every listed id matches EXACTLY one requested entry (an unknown id is
 *     a typo that would silently annotate nothing; two entries sharing an id
 *     make "which one" unanswerable, so both are refused);
 *   - no id appears in both lists, since `mandatory` and `optIn` contradict.
 *
 * Unknown keys inside `consent` are ignored rather than refused: a future
 * annotation must be able to reach an older server without breaking the
 * user's sign-in, which is the whole reason the sidecar exists.
 *
 * The sidecar is the ONLY source of annotations here. Any annotation written
 * inside a requested entry is dropped, so `requestedPermissions` stays what
 * the app sent and can be echoed back byte for byte.
 */
export function resolveConsentSidecar (requestedPermissions: unknown, sidecar: unknown): ConsentForm {
  if (sidecar == null || typeof sidecar !== 'object' || Array.isArray(sidecar)) {
    throw new ConsentSidecarError('consent must be an object');
  }
  const raw = sidecar as Record<string, unknown>;

  if (raw.allowUserChoice !== undefined && typeof raw.allowUserChoice !== 'boolean') {
    throw new ConsentSidecarError('consent.allowUserChoice must be a boolean');
  }
  const mandatoryIds = readIdList(raw.mandatory, 'mandatory');
  const optInIds = readIdList(raw.optIn, 'optIn');

  let permissions: ConsentFormPermission[];
  try {
    // Plain normalization first, which drops any annotation written inside
    // an entry: the sidecar is the only source of those, so an inline pair
    // must not be reported as a contradiction on a field that does not
    // count here.
    const plain = normalizePermissions(requestedPermissions);
    // Then the consent-form pass purely for its exclusion-mask guard: a
    // `level: 'none'` entry may not be offered, because dropping a mask
    // WIDENS access instead of narrowing it.
    normalizePermissions(plain, { consent: true });
    permissions = plain as ConsentFormPermission[];
  } catch (e: unknown) {
    throw new ConsentSidecarError((e as Error)?.message ?? String(e));
  }

  const byId = new Map<string, ConsentFormPermission[]>();
  for (const p of permissions) {
    const id = entryId(p);
    const bucket = byId.get(id);
    if (bucket === undefined) byId.set(id, [p]);
    else bucket.push(p);
  }

  const annotate = (ids: string[], field: 'mandatory' | 'optIn'): void => {
    for (const id of ids) {
      const bucket = byId.get(id);
      if (bucket === undefined) {
        throw new ConsentSidecarError(
          `consent.${field} names '${id}', which is not among requestedPermissions`
        );
      }
      if (bucket.length > 1) {
        throw new ConsentSidecarError(
          `consent.${field} names '${id}', which matches ${bucket.length} requested permissions ` +
          '(ambiguous: give each requested entry a distinct id)'
        );
      }
      bucket[0][field] = true;
    }
  };

  const both = mandatoryIds.filter((id) => optInIds.includes(id));
  if (both.length > 0) {
    throw new ConsentSidecarError(
      `consent lists '${both[0]}' as both mandatory and optIn, which contradict ` +
      '(a mandatory entry cannot be offered unselected)'
    );
  }
  annotate(mandatoryIds, 'mandatory');
  annotate(optInIds, 'optIn');

  return {
    allowUserChoice: raw.allowUserChoice === true,
    permissions
  };
}
