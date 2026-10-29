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
 * The account's former usernames: the names of its alias index that can hold
 * series. Minted aliases (`r-`) are never a username, so never a namespace.
 */
async function formerUsernames (aliasIndex: AliasIndexLike, userId: string, username: string): Promise<string[]> {
  const names: string[] = [];
  for (const name of new Set(await aliasIndex.getAliasesForId(userId))) {
    if (name === username || name.startsWith('r-')) continue;
    names.push(name);
  }
  return names;
}

/**
 * After a username change, bring the account's series under the namespace
 * of its username: the namespace of each former username (the name just
 * changed, and any a late write recreated after an earlier change) is merged
 * into it.
 * @returns the former usernames whose namespace was merged (a namespace
 *   holding nothing is a no-op of the series storage).
 */
async function gatherAccountSeries (conn: RenamingConnection, aliasIndex: AliasIndexLike, userId: string, username: string): Promise<string[]> {
  const target = seriesNamespace(username);
  const formers = await formerUsernames(aliasIndex, userId, username);
  for (const name of formers) {
    await conn.renameDatabase(seriesNamespace(name), target);
  }
  return formers;
}

type ExportingConnection = RenamingConnection & {
  exportDatabase (name: string): Promise<{ measurements?: Array<{ points?: unknown[] }> }>;
};

/**
 * One-time repair of an account renamed before username changes moved its
 * series: each former username's namespace that holds series is merged into
 * the username's ({@link gatherAccountSeries}' move: on a clash PostgreSQL
 * and SQLite keep the username's point, InfluxDB the moved one). A namespace holding
 * nothing is left alone, and nothing is created for it.
 * @param dryRun report only, move nothing.
 * @returns the namespaces found holding series, with their size.
 */
async function gatherFormerSeries (conn: ExportingConnection, aliasIndex: AliasIndexLike, userId: string, username: string, dryRun: boolean): Promise<Array<{ formerUsername: string; measurements: number; points: number }>> {
  const found: Array<{ formerUsername: string; measurements: number; points: number }> = [];
  for (const name of await formerUsernames(aliasIndex, userId, username)) {
    const measurements = (await conn.exportDatabase(seriesNamespace(name))).measurements ?? [];
    if (measurements.length === 0) continue;
    const points = measurements.reduce((n, m) => n + (m.points?.length ?? 0), 0);
    if (!dryRun) await conn.renameDatabase(seriesNamespace(name), seriesNamespace(username));
    found.push({ formerUsername: name, measurements: measurements.length, points });
  }
  return found;
}

export { seriesNamespace, accountSeriesNamespaces, formerUsernames, gatherAccountSeries, gatherFormerSeries };
