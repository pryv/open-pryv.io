/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Plan 66 — composite access references.
 *
 * Access versioning exposes references as `<base>` (no serial → original
 * / never-updated) or `<base>:<serial>` (numeric serial → that specific
 * contract version). Separator is `:`, URL-safe, never appearing inside
 * a cuid/cuid2 id so parsing is unambiguous.
 *
 * The composite form is only built/parsed at the wire seam — storage code
 * keeps `base` and `serial` in their own typed columns. See plan §1.
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
