/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type { PlatformEntry } from './PlatformDB.ts';

/**
 * A user field row of the platform store as an entry. The key is
 * `user-unique/<field>/<value>` (the row's value is its owner) or
 * `user-indexed/<field>/<username>` (the row's value is the field's value):
 * the type and the field end at the first two `/`, the rest of the key is the
 * value or the username whole, `/` included (an email local part, an
 * identity provider subject such as `https://idp/u/1`).
 */
export function parseUserRowEntry (entry: { key: string, value: string }): PlatformEntry {
  const key = entry.key;
  const typeEnd = key.indexOf('/');
  const fieldEnd = typeEnd === -1 ? -1 : key.indexOf('/', typeEnd + 1);
  const type = typeEnd === -1 ? key : key.slice(0, typeEnd);
  const field = typeEnd === -1 ? undefined : key.slice(typeEnd + 1, fieldEnd === -1 ? undefined : fieldEnd);
  const rest = fieldEnd === -1 ? undefined : key.slice(fieldEnd + 1);
  const isUnique = (type === 'user-unique');
  return {
    isUnique,
    field: field as string,
    username: (isUnique ? entry.value : rest) as string,
    value: (isUnique ? rest : entry.value) as string
  };
}
