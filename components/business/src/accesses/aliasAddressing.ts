/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { isMintedAliasShape } from '../users/aliasShape.ts';

/**
 * The name a request addressed the account by (the `/<name>/` path segment
 * or the `<name>.<domain>` host), and whether it is the account's username.
 */
export type AddressedName = { name: string; isCanonical: boolean };

/**
 * Alias-bound addressing: may `access` be used at `addressed`?
 *
 * An alias (`randomAlias`) is the only name an aliased access's holder knows
 * the account by. Accepting any token of the account at any of its names
 * would let two holders of aliased accesses learn whether their two aliases
 * are one person (each calls the other's alias with its own token), and let
 * the holder of an aliased access confirm a guessed username. So:
 *   - an access carrying an alias is used at that alias only, never at the
 *     username, a former username nor another access's alias;
 *   - an access without an alias is used at the account's own names (its
 *     username, a former username kept routable by a change of username),
 *     never at the alias of another access;
 *   - a personal access (the owner's session) is used at any of them.
 * A refusal answers exactly like an unknown token (see MethodContext), so it
 * tells the caller nothing about the account behind the name.
 *
 * The single place this rule lives: every transport reaches it through
 * MethodContext.
 */
export function accessMayBeAddressedAs (access: { type?: unknown; alias?: unknown }, addressed: AddressedName): boolean {
  if (access.type === 'personal') return true;
  const own = typeof access.alias === 'string' && access.alias.length > 0 ? access.alias : null;
  if (own != null) return addressed.name === own;
  return !isAccessAlias(addressed);
}

/**
 * Whether the request addressed the account by the alias of an access (not
 * by its username nor by a former username). Sign-in and password reset are
 * refused at such a name with one fixed answer: the holder of an alias must
 * not be able to confirm a guessed username, nor to send mails to the owner.
 *
 * Invariant the shape test rests on: an access alias is only ever produced by
 * `mintAlias` (the minted shape, which registration and a change of username
 * refuse as a username); `reserveSpecificAlias` backs former usernames only.
 * An address alias the owner minted is of that shape too: held by no access
 * it is reached with a personal token only, and once a grant adopts it, it is
 * that grant's alias like any other.
 * If an access alias were ever reserved by value, this test would have to
 * read the account's accesses instead of the shape.
 */
export function isAccessAlias (addressed: AddressedName): boolean {
  return !addressed.isCanonical && isMintedAliasShape(addressed.name);
}
