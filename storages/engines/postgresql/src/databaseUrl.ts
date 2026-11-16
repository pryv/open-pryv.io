/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * `DATABASE_URL` as a fallback for the PostgreSQL connection settings.
 *
 * Platforms such as Dokku (`postgres:link`) or Heroku hand the app its database as a
 * `DATABASE_URL` environment variable. When it is set, each of `host`, `port`,
 * `database`, `user` and `password` under `storages:engines:postgresql` that still has the
 * value of `config/default-config.yml` takes the value the URL gives; a value set anywhere
 * else (override file, environment, injected config) wins. A field the URL leaves out keeps
 * its configured value. Query parameters (`sslmode`, ...) are not read.
 *
 * A `DATABASE_URL` that does not parse as a `postgres://` / `postgresql://` URL fails the
 * boot rather than silently connecting to the default database. Neither the URL nor any
 * value from it is ever logged: only the names of the fields taken from it.
 */

export const DATABASE_URL_FIELDS = ['host', 'port', 'database', 'user', 'password'] as const;
export type DatabaseUrlField = typeof DATABASE_URL_FIELDS[number];
export type DatabaseUrlValues = Partial<{ host: string; port: number; database: string; user: string; password: string }>;

const CONFIG_KEY = 'storages:engines:postgresql';
/** boiler's scope name for `config/default-config.yml`. */
const DEFAULT_FILE_SCOPE = 'default-file';

/**
 * Parse a `DATABASE_URL` into the connection fields it carries.
 * Throws an Error whose message never contains the URL (it holds the password).
 */
export function parseDatabaseUrl (databaseUrl: string): DatabaseUrlValues {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL is set but is not a valid URL (expected postgres://user:password@host:port/database)');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL is set but its scheme is "' + url.protocol.replace(/:$/, '') + '", expected postgres or postgresql');
  }
  const values: DatabaseUrlValues = {};
  // IPv6 hosts come bracketed in a URL; the pg client wants them bare.
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (host !== '') values.host = host;
  if (url.port !== '') values.port = Number(url.port);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (database !== '') values.database = database;
  if (url.username !== '') values.user = decodeURIComponent(url.username);
  if (url.password !== '') values.password = decodeURIComponent(url.password);
  return values;
}

/**
 * The fields to take from the URL: those it carries whose effective value still comes from
 * the default config file (or from nowhere).
 */
export function fieldsToFill (values: DatabaseUrlValues, scopeOf: (field: DatabaseUrlField) => string | null): DatabaseUrlField[] {
  return DATABASE_URL_FIELDS.filter((field) => {
    if (values[field] === undefined) return false;
    const scope = scopeOf(field);
    return scope === null || scope === DEFAULT_FILE_SCOPE;
  });
}

type ScopedConfig = {
  getScopeAndValue?: (key: string) => { scope: string } | null;
  set?: (key: string, value: unknown) => void;
};

/**
 * Apply `DATABASE_URL` (from `env`) to the config, in place. Returns the names of the fields
 * taken from it (empty when the variable is unset, or when the config cannot tell where its
 * values come from).
 */
export function applyDatabaseUrl (config: ScopedConfig, env: Record<string, string | undefined> = process.env): DatabaseUrlField[] {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl == null || databaseUrl === '') return [];
  if (typeof config.getScopeAndValue !== 'function' || typeof config.set !== 'function') return [];
  const values = parseDatabaseUrl(databaseUrl);
  const fields = fieldsToFill(values, (field) => config.getScopeAndValue!(CONFIG_KEY + ':' + field)?.scope ?? null);
  for (const field of fields) config.set!(CONFIG_KEY + ':' + field, values[field]);
  return fields;
}
