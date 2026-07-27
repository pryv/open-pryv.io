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
// A (user, field) can hold SEVERAL PlatformDB rows: the `email` field may own
// more than one value (multiple emails per account), so entries are kept as a
// list per field. Only `email` is legitimately multi-row — the primary is
// matched against the repository and any leftover email rows are cross-checked
// against the account's `:_emails:` container; a leftover on any OTHER field is
// reported as an orphan.
type PerUserEntries = Record<string, Record<string, Array<{ value: unknown; isUnique: boolean }>>>;

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
    // NOTE: `sso-<provider>` third-party-sign-in bindings are ALSO platform-only
    // (no System Streams counterpart), but they are NOT skipped here — they are
    // removed per known user in the match pass below, so an sso row owned by no
    // repository user (a partially-failed delete) still surfaces as an orphan.
    // Because these rows route logins, orphan detection matters.
    // Skip entries without a username (e.g. user-core/ prefix entries)
    if (entry.username == null) continue;
    // Skip reserved usernames (e.g. __cores__ for core registration).
    // In hashed mode reserved usernames stay cleartext (they're not user
    // PII — they're well-known sentinels) so the `__` check still works.
    if (entry.username.startsWith('__')) continue;
    if (platformEntryByUser[entry.username] == null) platformEntryByUser[entry.username] = {};
    if (platformEntryByUser[entry.username][entry.field] == null) platformEntryByUser[entry.username][entry.field] = [];
    platformEntryByUser[entry.username][entry.field].push({ value: entry.value, isUnique: entry.isUnique });
  }

  const errors: string[] = [];
  // Retrieve all existing users
  const usersRepository = await getUsersRepository();
  const usersFromRepository = await usersRepository.getAll();
  const indexedFields = accountStreams.indexedFieldNames;

  // Lazy requires (circular-import avoidance, same as the repository require
  // above — emails/container.ts imports `platform`). Used only to cross-check
  // leftover `email` rows against a user's `:_emails:` container events; the
  // container is fetched only for users who actually hold extra email rows.
  const emailsContainer = require('business/src/emails/container.ts');
  const EMAIL_FIELD = require('business/src/emails/constants.ts').UNIQUE_FIELD;
  // Once the container store proves unreachable for one user, stop trying for
  // the rest of the run: a lazy re-init on every user could hang (and is a
  // heavyweight side effect). `emailCrossCheckSkipped` surfaces the degradation
  // in `infos` so a silent skip leaves a trace instead of a false all-clear.
  let crossCheckUnavailable = false;
  let emailCrossCheckSkipped = 0;

  // Cross-check a user's leftover `email` platform rows against their
  // `:_emails:` container. `primaryToken` is the already-matched primary row's
  // token form (kept for the reverse check). Both directions are token-vs-token,
  // so hashed mode is handled by `tokenFor` (identity in cleartext mode).
  async function crossCheckEmailRows (
    userId: string, username: string,
    leftoverRows: Array<{ value: unknown }>, primaryToken: unknown
  ): Promise<void> {
    if (crossCheckUnavailable) { emailCrossCheckSkipped++; return; }
    let rawEvents: Array<{ content?: { value?: unknown } }>;
    try {
      rawEvents = await emailsContainer.getRawEvents(userId);
    } catch (_err) {
      // Container store not reachable in this caller (e.g. a platform-only
      // integrity context, or a per-user store error): skip the container
      // cross-check for the REST of the run rather than retry per user, and
      // record it in `infos` so the degradation is not silent.
      crossCheckUnavailable = true;
      emailCrossCheckSkipped++;
      return;
    }
    const containerTokens = new Set(
      rawEvents.map((ev) => tokenFor(EMAIL_FIELD, String(ev.content?.value)))
    );
    // Forward: every leftover platform row must be backed by a container email.
    for (const row of leftoverRows) {
      if (!containerTokens.has(String(row.value))) {
        errors.push(`Found email row with value: "${row.value}" for username "${username}" in the platform db with no matching email on the account`);
      }
    }
    // Reverse (opportunistic — the container was fetched anyway): every
    // container email must own a platform row. A container email whose row was
    // lost while NO other leftover row exists is not caught here (the container
    // is never fetched for a single-row user); full reverse coverage would cost
    // a mall read per user and is intentionally deferred.
    const allRowTokens = new Set([String(primaryToken), ...leftoverRows.map((r) => String(r.value))]);
    for (const token of containerTokens) {
      if (!allRowTokens.has(token)) {
        errors.push(`Account of "${username}" holds an email with no matching row in the platform db (token "${token}")`);
      }
    }
  }

  const infos: { usersCountOnPlatform: number; usersCountOnRepository: number; emailCrossCheckSkipped: number } = {
    usersCountOnPlatform: Object.keys(platformEntryByUser).length,
    usersCountOnRepository: usersFromRepository.length,
    emailCrossCheckSkipped: 0
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

      const fieldEntries = platformEntryByUser[usernameKey]?.[field];
      if (platformEntryByUser[usernameKey] == null) {
        errors.push(`Cannot find username "${username}" data in platform db while looking for field "${field}" expected value:  "${valueRepo}"`);
        continue;
      } else if (fieldEntries == null || fieldEntries.length === 0) {
        errors.push(`Cannot find field "${field}" for username "${username}" in the platform db expected value is :  "${valueRepo}"`);
      } else {
        // Match the repository value against ANY of the field's rows. A unique
        // field may carry several rows (multiple owned emails); the repository
        // holds the singular/primary, which must be present among them.
        const matchIdx = fieldEntries.findIndex((e) => e.value === expectedValue);
        if (matchIdx === -1) {
          errors.push(`Expected value "${valueRepo}" of field "${field}" for username "${username}" in the platform db but found value :  "${fieldEntries[0].value}"`);
        } else {
          if (fieldEntries[matchIdx].isUnique !== isUnique) {
            const txt = isUnique ? 'unique found indexed' : 'indexed found unique';
            errors.push(`Expected value "${valueRepo}" of field "${field}" for username "${username}" in the platform db to be "${txt}"`);
          }
          // Remove only the matched (repository / primary) row, then account
          // for any remaining rows of this field.
          fieldEntries.splice(matchIdx, 1);
          if (fieldEntries.length === 0) {
            delete platformEntryByUser[usernameKey][field];
          } else if (field === EMAIL_FIELD) {
            // The `email` field legitimately holds several rows (multiple owned
            // emails). Cross-check the leftovers against the account's
            // `:_emails:` container: every extra row must be backed by a
            // container email record, and (opportunistically, since we fetch it)
            // every container email must own a platform row. The container holds
            // cleartext; platform rows hold the token form (HMAC in hashed mode),
            // so bridge via tokenFor exactly as the primary match does.
            await crossCheckEmailRows(userRepo.id, username, fieldEntries, expectedValue);
            delete platformEntryByUser[usernameKey][field];
          } else {
            // A non-email single-valued unique/indexed field must hold exactly
            // one row; any leftover after the primary match is an orphan.
            for (const row of fieldEntries) {
              errors.push(`Found extra row with value: "${row.value}" of single-valued field "${field}" for username "${username}" in the platform db`);
            }
            delete platformEntryByUser[usernameKey][field];
          }
        }
      }
      // if user in platformEntryByUser is empty delete it
      if (platformEntryByUser[usernameKey] != null && Object.keys(platformEntryByUser[usernameKey]).length === 0) delete platformEntryByUser[usernameKey];
    }

    // Remove THIS known user's platform-only `sso-<provider>` binding rows. The
    // account-field pass above never matches them (they have no System Streams
    // counterpart), but they legitimately belong to this repository user — so
    // dropping them here leaves only sso rows owned by NO repository user to
    // survive to the leftover pass, where they are correctly reported as
    // orphans (a stale binding that could mis-route an SSO login).
    // Guard: never drop a real (possibly custom) account field that merely
    // happens to be named `sso-*` — those are handled by the match pass above,
    // so a leftover one is a genuine error we must NOT hide.
    if (platformEntryByUser[usernameKey] != null) {
      for (const field of Object.keys(platformEntryByUser[usernameKey])) {
        if (field.startsWith('sso-') &&
            !indexedFields.includes(field) &&
            !accountStreams.uniqueFieldNames.includes(field)) {
          delete platformEntryByUser[usernameKey][field];
        }
      }
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
      for (const leftover of platformEntryByUser[usernameKey][field]) {
        errors.push(`Found field "${field}" with value: "${leftover.value}" for username "${usernameKey}" in the platform db but not in the Repository (System Streams)`);
      }
    }
  }
  infos.emailCrossCheckSkipped = emailCrossCheckSkipped;
  return {
    title: 'Platform DB vs users repository',
    infos,
    errors
  };
}
