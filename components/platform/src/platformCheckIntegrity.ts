/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const accountStreams = require('business/src/system-streams/index.ts');

type PlatformEntry = { field: string; username?: string; value: unknown; isUnique: boolean };
type PlatformDBLike = { getAllWithPrefix: (prefix: string) => Promise<PlatformEntry[]> };
type PiiHasherLike = { hashFor: (field: string, value: string) => string };
type IntegrityOptions = { hasher?: PiiHasherLike | null };
type PerUserEntries = Record<string, Record<string, { value: unknown; isUnique: boolean }>>;

const USERNAME_FIELD = 'username';

export default async function platformCheckIntegrity (
  platformWideDB: PlatformDBLike,
  options: IntegrityOptions = {}
) {
  const { getUsersRepository } = require('business/src/users/repository.ts'); // to avoid some circular import
  const hasher = options.hasher ?? null;

  // `tokenFor` returns the PlatformDB-storage form of a plaintext: HMAC
  // when hashed mode is active, plaintext otherwise. The compare loop
  // below uses it to bridge the repository's plaintext view to PlatformDB's
  // potentially-hashed row keys + values.
  const tokenFor = (field: string, plaintext: string): string =>
    hasher == null ? plaintext : hasher.hashFor(field, plaintext);

  // --- platformDB
  const allEntries = await platformWideDB.getAllWithPrefix('user');
  const platformEntryByUser: PerUserEntries = {};
  for (const entry of allEntries) {
    // Skip internal fields (e.g. _core for multi-core mapping)
    if (entry.field && entry.field.startsWith('_')) continue;
    // Skip `alias`: a per-access routable de-identifying name reserved for
    // cross-core uniqueness. It is NOT a user account (System Streams) field,
    // so it has no repository counterpart by design.
    if (entry.field === 'alias') continue;
    // Skip entries without a username (e.g. user-core/ prefix entries)
    if (entry.username == null) continue;
    // Skip reserved usernames (e.g. __cores__ for core registration).
    // In hashed mode reserved usernames stay cleartext (they're not user
    // PII — they're well-known sentinels) so the `__` check still works.
    if (entry.username.startsWith('__')) continue;
    if (platformEntryByUser[entry.username] == null) platformEntryByUser[entry.username] = {};
    platformEntryByUser[entry.username][entry.field] = { value: entry.value, isUnique: entry.isUnique };
  }

  const errors: string[] = [];
  // Retrieve all existing users
  const usersRepository = await getUsersRepository();
  const usersFromRepository = await usersRepository.getAll();
  const indexedFields = accountStreams.indexedFieldNames;

  const infos = {
    usersCountOnPlatform: Object.keys(platformEntryByUser).length,
    usersCountOnRepository: usersFromRepository.length
  };

  for (let i = 0; i < usersFromRepository.length; i++) {
    const userRepo = usersFromRepository[i];
    if (userRepo == null) {
      errors.push('Found null or undefined user in usersRepository when listing with getAll()"');
      continue;
    }
    const username = userRepo.username;
    if (username == null) {
      errors.push('Found null or undefined username in usersRepository for user with id: "' + userRepo.id + '"');
      continue;
    }

    // The repository holds plaintext; PlatformDB rows are keyed by the
    // token form (== plaintext in cleartext mode, HMAC in hashed mode).
    // Look up PlatformDB by token, but keep `username` (plaintext) in
    // error messages so operators see something they can act on.
    const usernameKey = tokenFor(USERNAME_FIELD, username);

    for (const field of indexedFields) {
      const valueRepo = userRepo[field];

      if (valueRepo == null) continue; // we do not expect to find null values in repo

      const isUnique = accountStreams.uniqueFieldNames.includes(field);
      // Unique fields are stored hashed (key + value); indexed fields are
      // stored cleartext (only the username key is hashed). The expected
      // PlatformDB value is therefore the token form for isUnique fields
      // and the raw repo value for indexed fields.
      const expectedValue = isUnique ? tokenFor(field, String(valueRepo)) : valueRepo;

      if (platformEntryByUser[usernameKey] == null) {
        errors.push(`Cannot find username "${username}" data in platform db while looking for field "${field}" expected value:  "${valueRepo}"`);
        continue;
      } else if (platformEntryByUser[usernameKey][field] == null) {
        errors.push(`Cannot find field "${field}" for username "${username}" in the platform db expected value is :  "${valueRepo}"`);
      } else if (platformEntryByUser[usernameKey][field].value !== expectedValue) {
        errors.push(`Expected value "${valueRepo}" of field "${field}" for username "${username}" in the platform db but found value :  "${platformEntryByUser[usernameKey][field].value}"`);
      } else if (platformEntryByUser[usernameKey][field].isUnique !== isUnique) {
        const txt = isUnique ? 'unique found indexed' : 'indexed found unique';
        errors.push(`Expected value "${valueRepo}" of field "${field}" for username "${username}" in the platform db to be "${txt}"`);
      }
      // all tests passed delete entry from platformEntryByUser
      delete platformEntryByUser[usernameKey][field];
      // if user in platformEntryByUser is empty delete it
      if (Object.keys(platformEntryByUser[usernameKey]).length === 0) delete platformEntryByUser[usernameKey];
    }
  }

  // data left in platformEntryByUser is what has not be found in users from repository.
  // In hashed mode the leftover keys are HMAC tokens — we cannot reverse-resolve
  // back to a plaintext username for repository lookup, so the "found in platform
  // but not in repo" diagnostic surfaces the token. Operators correlate via the
  // home core's user-account storage.
  for (const usernameKey of Object.keys(platformEntryByUser)) {
    if (hasher == null) {
      const userFromRepository = await usersRepository.getUserByUsername(usernameKey);
      if (userFromRepository == null) {
        errors.push(`Found data for user with username "${usernameKey}" in the platform db but cannot find this user in the Repository (System Streams)`);
      }
    } else {
      errors.push(`Found data for user with hashed-username token "${usernameKey}" in the platform db but no matching user was found in the Repository pass above (hashed mode — cannot reverse the token)`);
    }
    for (const field of Object.keys(platformEntryByUser[usernameKey])) {
      errors.push(`Found field "${field}" with value: "${platformEntryByUser[usernameKey][field].value}" for username "${usernameKey}" in the platform db but not in the Repository (System Streams)`);
    }
  }
  return {
    title: 'Platform DB vs users repository',
    infos,
    errors
  };
}
