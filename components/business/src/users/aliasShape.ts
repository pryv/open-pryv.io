/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// The shapes of the aliases the users repository mints: `r-` + 8 characters
// for the alias of an access (`randomAlias`, a pseudonymous grant), `a-` + 8
// characters for an address alias the account owner creates (an address of
// the account an OAuth grant adopts at consent). Both are refused as a new
// username, so no account can take a name an alias may later be minted as. A
// username merely starting with `r-` or `a-` (`r-johnny`) is a username like
// any other.
const ACCESS_ALIAS_PREFIX = 'r-';
const ADDRESS_ALIAS_PREFIX = 'a-';
const ALIAS_SHAPE_RE = /^[ar]-[a-z0-9]{8}$/;
const ADDRESS_ALIAS_SHAPE_RE = /^a-[a-z0-9]{8}$/;

/** Whether `name` has the shape of a minted alias (of an access, or an address alias). */
function isMintedAliasShape (name: string): boolean {
  return ALIAS_SHAPE_RE.test(name);
}

/** Whether `name` has the shape of an address alias (minted for the account owner). */
function isAddressAliasShape (name: string): boolean {
  return ADDRESS_ALIAS_SHAPE_RE.test(name);
}

export { ALIAS_SHAPE_RE, ADDRESS_ALIAS_SHAPE_RE, ACCESS_ALIAS_PREFIX, ADDRESS_ALIAS_PREFIX, isMintedAliasShape, isAddressAliasShape };
