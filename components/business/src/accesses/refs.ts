/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Composite access references.
 *
 * Access versioning exposes references as `<base>` (no serial → original
 * / never-updated) or `<base>:<serial>` (numeric serial → that specific
 * contract version). Separator is `:`, URL-safe, never appearing inside
 * a cuid/cuid2 id so parsing is unambiguous.
 *
 * The composite form is only built/parsed at the wire seam — storage code
 * keeps `base` and `serial` in their own typed columns.
 */

export type AccessRef = { base: string, serial: number | null };

/**
 * Parse a wire-format reference into `{ base, serial }`. Accepts both
 * bare cuid (`"abc123"` → `{ base: 'abc123', serial: null }`) and
 * composite (`"abc123:3"` → `{ base: 'abc123', serial: 3 }`).
 *
 * Throws `Error` if the input is non-string or empty. Throws if the
 * serial part is present but not a non-negative integer (NaN guard).
 * Bare-string IDs that happen to contain unrelated colons would be
 * detected here — but every Pryv access id is a cuid/cuid2 which is
 * `[a-z0-9]+`, no colons. The colon split is unambiguous in practice.
 */
export function parseAccessRef (ref: string): AccessRef {
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new Error('parseAccessRef: expected a non-empty string, got ' + JSON.stringify(ref));
  }
  const colonIdx = ref.indexOf(':');
  if (colonIdx === -1) {
    return { base: ref, serial: null };
  }
  const base = ref.slice(0, colonIdx);
  const tail = ref.slice(colonIdx + 1);
  if (base.length === 0) {
    throw new Error('parseAccessRef: empty base in ' + JSON.stringify(ref));
  }
  const serial = Number(tail);
  if (!Number.isInteger(serial) || serial < 1) {
    throw new Error('parseAccessRef: serial must be a positive integer, got ' + JSON.stringify(tail));
  }
  return { base, serial };
}

/**
 * Render an `{ base, serial }` pair back to the wire format. Bare cuid
 * when serial is null/undefined; `<base>:<serial>` otherwise.
 */
export function serializeAccessRef (ref: AccessRef): string {
  if (ref == null || typeof ref.base !== 'string' || ref.base.length === 0) {
    throw new Error('serializeAccessRef: ref.base must be a non-empty string');
  }
  if (ref.serial == null) return ref.base;
  if (!Number.isInteger(ref.serial) || ref.serial < 1) {
    throw new Error('serializeAccessRef: serial must be a positive integer, got ' + JSON.stringify(ref.serial));
  }
  return ref.base + ':' + ref.serial;
}

/**
 * `createdBy` / `modifiedBy` are stored either as the bare access id
 * (`<base>`) or as access-id-plus-caller (`<base> <callerId>`). The
 * space-separator survives the composite rewrite — splice the
 * `:<serial>` into the access-id part and keep the callerId tail.
 */
function composeStoredRef (storedRef: string | undefined | null, serial: number | null | undefined): string | undefined | null {
  if (storedRef == null) return storedRef;
  if (serial == null) return storedRef;
  const spaceIdx = storedRef.indexOf(' ');
  if (spaceIdx === -1) return storedRef + ':' + serial;
  return storedRef.slice(0, spaceIdx) + ':' + serial + storedRef.slice(spaceIdx);
}

/**
 * Rewrite an access storage row into the wire-format access object.
 * Composes the composite `id` / `createdBy` / `modifiedBy` when a
 * corresponding serial is set, and strips the internal `serial` +
 * `*BySerial` fields so the response stays inside the API schema's
 * `additionalProperties: false` whitelist. Pass `historyOfBase` when
 * surfacing a history row — the wire `id` then encodes the FROZEN
 * serial of that row (e.g. `<base>:2`) rather than the storage's
 * fresh history-row id.
 */
type AccessRow = {
  id: string;
  serial?: number | null;
  createdBy?: string | null;
  createdBySerial?: number | null;
  modifiedBy?: string | null;
  modifiedBySerial?: number | null;
  headId?: string;
  [k: string]: unknown;
};
export function composeWireAccess (row: AccessRow, historyOfBase?: string): Record<string, unknown> {
  if (row == null) return row;
  const out = Object.assign({}, row);
  const baseId = historyOfBase != null ? historyOfBase : row.id;
  out.id = serializeAccessRef({ base: baseId, serial: row.serial ?? null });
  if (row.createdBy != null) {
    out.createdBy = composeStoredRef(row.createdBy, row.createdBySerial ?? null);
  }
  if (row.modifiedBy != null) {
    out.modifiedBy = composeStoredRef(row.modifiedBy, row.modifiedBySerial ?? null);
  }
  delete out.serial;
  delete out.createdBySerial;
  delete out.modifiedBySerial;
  delete out.headId;
  return out;
}
