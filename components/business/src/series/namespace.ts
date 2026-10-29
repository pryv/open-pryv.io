/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// The series engines key a user's HF data by this namespace (the "database"
// of the series connection), not by the user id. Every caller that reads,
// writes, exports, imports or drops a user's series must derive it here, or it
// silently addresses a namespace nobody else uses.
function seriesNamespace (username: string): string {
  return `user.${username}`;
}

type AliasIndexLike = { getAliasesForId (userId: string): Promise<string[]> };

/**
 * The namespaces of every name the account holds: its username and each of
 * its aliases. A username change demotes the former name to an alias and
 * moves its series (see {@link gatherAccountSeries}), but a move that failed
 * or a late write can leave points under a former name, so erasing the
 * account's series (or one measurement of it) must cover all of them.
 */
async function accountSeriesNamespaces (aliasIndex: AliasIndexLike, userId: string, username: string): Promise<string[]> {
  const aliases = await aliasIndex.getAliasesForId(userId);
  return [...new Set([username, ...aliases])].map(seriesNamespace);
}

type RenamingConnection = { renameDatabase (from: string, to: string): Promise<void> | void };

/**
 * After a username change, bring the account's series under the namespace
 * of its username: the namespace of each former username (the name just
 * changed, and any a late write recreated after an earlier change) is merged
 * into it. Minted aliases (`r-`) are never a username, so never a namespace.
 */
async function gatherAccountSeries (conn: RenamingConnection, aliasIndex: AliasIndexLike, userId: string, username: string): Promise<void> {
  const target = seriesNamespace(username);
  for (const name of new Set(await aliasIndex.getAliasesForId(userId))) {
    if (name === username || name.startsWith('r-')) continue;
    await conn.renameDatabase(seriesNamespace(name), target);
  }
}

export { seriesNamespace, accountSeriesNamespaces, gatherAccountSeries };
