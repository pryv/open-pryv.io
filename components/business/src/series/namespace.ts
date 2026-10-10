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
 * leaves the series written before it under that name, so erasing the
 * account's series (or one measurement of it) must cover all of them.
 */
async function accountSeriesNamespaces (aliasIndex: AliasIndexLike, userId: string, username: string): Promise<string[]> {
  const aliases = await aliasIndex.getAliasesForId(userId);
  return [...new Set([username, ...aliases])].map(seriesNamespace);
}

export { seriesNamespace, accountSeriesNamespaces };
