/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: `oauth:audienceBoundSessions`, read the same way by the data API
 * check, the boot report and the configuration validators.
 *
 * A security switch: `true` (or the string `true`, as an environment
 * variable gives it, any case) refuses at the data API the sessions minted
 * for a resource server; `false`, the string `false` or absent keeps them
 * usable. Anything else is a configuration error (the boot refuses it), never
 * read silently as one or the other.
 */

/** The setting as a boolean, or null when it is neither a boolean nor `true` / `false`. */
export function parseAudienceBoundSessions (value: unknown): boolean | null {
  if (value == null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  return null;
}

/** Whether this core refuses at the data API the sessions minted for a resource server. */
export function audienceBoundSessions (config: { get (key: string): unknown }): boolean {
  return parseAudienceBoundSessions(config.get('oauth:audienceBoundSessions')) === true;
}

/** The configuration problem of a value that is not a boolean, or null. */
export function audienceBoundSessionsProblem (value: unknown): string | null {
  if (parseAudienceBoundSessions(value) != null) return null;
  return `oauth.audienceBoundSessions is ${JSON.stringify(value)}: true or false is expected (it decides whether the data API ` +
    'refuses the tokens issued for a resource server).';
}
