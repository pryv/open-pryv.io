/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The SSO bindings of an account in a single-account backup: the platform's
 * unique `sso-<provider>` rows the account owns (the identity provider's
 * subject, in the platform's storage form). A whole backup carries them in
 * its platform rows; a single-account backup carries no platform rows, so it
 * writes them with the account.
 */

import type { PlatformEntry } from '../../../../storages/interfaces/platformStorage/PlatformDB.ts';

/** The platform field of a provider's bindings is this prefix and the provider id. */
export const SSO_BINDING_FIELD_PREFIX = 'sso-';

/** One binding as a backup holds it. */
export type SsoBinding = { field: string; value: string };

/** The bindings among an account's platform rows. */
export function ssoBindingsOf (rows: PlatformEntry[]): SsoBinding[] {
  return rows
    .filter((row) => row.isUnique === true && isSsoBindingField(row.field))
    .map((row) => ({ field: row.field, value: row.value }));
}

/**
 * True for an entry a restore may write as a binding: an `sso-<provider>`
 * field (nothing else: the entry comes from a backup, and must not write an
 * email, an alias or another unique value of the platform) and a value.
 */
export function isSsoBinding (entry: unknown): entry is SsoBinding {
  const e = entry as { field?: unknown; value?: unknown } | null;
  return e != null && isSsoBindingField(e.field) && typeof e.value === 'string' && e.value !== '' && !e.value.includes('/');
}

function isSsoBindingField (field: unknown): field is string {
  return typeof field === 'string' && field.length > SSO_BINDING_FIELD_PREFIX.length &&
    field.startsWith(SSO_BINDING_FIELD_PREFIX) && !field.includes('/');
}
