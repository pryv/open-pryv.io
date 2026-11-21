/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * User ids for storage-level tests that write rows under an id of their own,
 * without registering an account. On PostgreSQL the database refuses rows of
 * a user id the users index does not hold, so each id is indexed first (under
 * a username derived from it); `unindexUserIds` removes the entries again.
 */

import cuid from 'cuid';
import { getUsersLocalIndex } from 'storage';

const indexed = new Set<string>();

/** A fresh user id, indexed (username `t` + the id, lowercased). */
async function indexedUserId (): Promise<string> {
  const userId = cuid();
  await (await getUsersLocalIndex()).addUser('t' + userId.toLowerCase(), userId);
  indexed.add(userId);
  return userId;
}

/** Remove the index entries of `userIds` (default: every id `indexedUserId` gave). */
async function unindexUserIds (userIds: Iterable<string> = [...indexed]): Promise<void> {
  const index = await getUsersLocalIndex();
  for (const userId of userIds) {
    await index.deleteById(userId);
    indexed.delete(userId);
  }
}

/**
 * Run `write` while `userIds` are indexed, then remove the entries this call
 * added: the rows written stay under ids the index lacks. That is the state
 * the sweeps and the integrity check deal with (an account whose index entry
 * went and whose rows stayed, or rows from before the database refused them).
 * An id already indexed is left as it is.
 */
async function writeAsOrphans<T> (userIds: string[], write: () => Promise<T>): Promise<T> {
  const index = await getUsersLocalIndex();
  const added: string[] = [];
  try {
    for (const userId of userIds) {
      if (await index.getUsername(userId) != null) continue;
      await index.addUser('orphan' + userId.toLowerCase(), userId);
      added.push(userId);
    }
    return await write();
  } finally {
    for (const userId of added) await index.deleteById(userId);
  }
}

export { indexedUserId, unindexUserIds, writeAsOrphans };
