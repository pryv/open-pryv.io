/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// The shape of a minted access alias: `r-` + 8 characters (the users
// repository mints them). Refused as a new username, so no account can take
// a name an alias may later be minted as. A username merely starting with
// `r-` (`r-johnny`) is a username like any other.
const ALIAS_SHAPE_RE = /^r-[a-z0-9]{8}$/;

/** Whether `name` has the shape of a minted access alias. */
function isMintedAliasShape (name: string): boolean {
  return ALIAS_SHAPE_RE.test(name);
}

export { ALIAS_SHAPE_RE, isMintedAliasShape };
