/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Shared by `scripts/update-event-types` (writes the vendored copies) and
// `scripts/event-types-fixture-guard` (checks them), so both apply the same rule.
//
// Two vendored copies of the published event-type catalogue:
// - the TEST fixture `test/event-types-flat.json` is the published catalogue,
//   verbatim;
// - the RUNTIME seed `components/business/src/types/event-types.default.json` is
//   the published catalogue applied onto the previous seed, entry by entry: every
//   published type (and extras / classes / sets entry, and the version) replaces
//   the seed's, and entries no longer published are KEPT. A running core merges
//   its download into the seed additively, so it still accepts types removed
//   upstream; keeping them makes a core that cannot reach the catalogue validate
//   like one that can. Replacing each published entry whole (rather than merging
//   it) keeps a key removed inside a type from surviving in the seed forever.

import { readFileSync } from 'node:fs';

export const FIXTURE_PATH = 'test/event-types-flat.json';
export const SEED_PATH = 'components/business/src/types/event-types.default.json';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Canonical form: sorted keys, no insignificant whitespace. Compares content,
// not serialization. Array order is significant (`required`, `enum`).
export function canonical (value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function parseCatalogue (text) {
  const parsed = JSON.parse(text);
  if (!isPlainObject(parsed) || !isPlainObject(parsed.types)) {
    throw new Error('not an event-types catalogue (no "types" object)');
  }
  return parsed;
}

export function loadCatalogue (path) {
  return parseCatalogue(readFileSync(path, 'utf-8'));
}

// The runtime seed rule, see the header.
export function applyToSeed (seed, published) {
  const result = structuredClone(seed);
  for (const [section, value] of Object.entries(published)) {
    if (isPlainObject(value) && isPlainObject(result[section])) {
      for (const [key, entry] of Object.entries(value)) result[section][key] = structuredClone(entry);
    } else {
      result[section] = structuredClone(value);
    }
  }
  return result;
}

// How `actual` differs from `expected`, by type and by top-level section.
export function describeDifference (actual, expected) {
  const missing = Object.keys(expected.types).filter((t) => !(t in actual.types));
  const extra = Object.keys(actual.types).filter((t) => !(t in expected.types));
  const changed = Object.keys(expected.types)
    .filter((t) => t in actual.types && canonical(expected.types[t]) !== canonical(actual.types[t]));
  const sections = [...new Set([...Object.keys(actual), ...Object.keys(expected)])]
    .filter((k) => k !== 'types' && canonical(actual[k]) !== canonical(expected[k]));
  return { missing, extra, changed, sections };
}

export function serialize (catalogue) {
  return JSON.stringify(catalogue, null, 2);
}
