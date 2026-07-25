/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Multiple emails, account-method operations.
 *
 * These orchestrate the container events and the shared `email` PlatformDB
 * uniqueness rows for the `account.update` `emails` operations object and for
 * the legacy `account.update {email}` compatibility sync. The primary email
 * stays governed by the legacy singular field: setPrimary and the legacy sync
 * reuse the exact same platform + repository swap the legacy path performs, so
 * uniqueness handling for the singular field stays byte-identical.
 */

import * as C from './constants.ts';
import * as container from './container.ts';

import { getPlatform } from 'platform';
import timestamp from 'unix-timestamp';

type ErrorsFactory = {
  invalidOperation (msg?: string, data?: unknown): Error;
  itemAlreadyExists (resource: string, data?: unknown): Error;
};
type UsersRepositoryLike = {
  updateOne (user: unknown, update: Record<string, unknown>, accessId: string): Promise<unknown>;
};
type Deps = { errors: ErrorsFactory; usersRepository: UsersRepositoryLike };
type UserContext = { userId: string; username: string; user: unknown; accessId: string; legacyEmail: string | null };

/** Seed the container from the legacy primary on first use (existing users). */
async function ensureSeeded (userId: string, legacyEmail: string | null): Promise<void> {
  await container.ensureContainerStream(userId);
  const events = await container.getRawEvents(userId);
  if (events.length === 0 && legacyEmail != null) {
    await container.createEmailEvent(userId, {
      value: legacyEmail,
      primary: true,
      status: C.STATUS_VERIFIED,
      verifiedAt: null,
      verificationMethod: null
    });
  }
}

/**
 * The legacy email swap: exactly what `account.update {email}` performs, so the
 * singular field's PlatformDB row handling is identical whether the change
 * comes from the legacy field or from setPrimary.
 */
async function legacyEmailSwap (deps: Deps, ctx: UserContext, oldValue: string | null, newValue: string): Promise<void> {
  const platform = await getPlatform();
  await platform.updateUser(ctx.username, [{
    action: 'update',
    key: 'email',
    value: newValue,
    previousValue: oldValue,
    isUnique: true,
    isActive: true
  }]);
  await deps.usersRepository.updateOne(ctx.user, { email: newValue }, ctx.accessId);
}

/** add: reserve a row + create a pending, non-primary event per value. */
async function addEmails (deps: Deps, ctx: UserContext, values: string[]): Promise<void> {
  const errors = deps.errors;
  await ensureSeeded(ctx.userId, ctx.legacyEmail);
  const max = await container.getMaxEmails();
  let count = (await container.getRawEvents(ctx.userId)).length;

  const reservedThisCall: string[] = [];
  const createdThisCall: string[] = [];
  try {
    for (const value of values) {
      const present = await container.findRawByValue(ctx.userId, value);
      if (present != null || createdThisCall.includes(value)) {
        throw errors.invalidOperation('This email is already registered on the account.', { email: value });
      }
      if (count >= max) {
        throw errors.invalidOperation(`Maximum number of emails (${max}) reached.`, { maxEmails: max });
      }
      const reserved = await container.reserveRow(ctx.username, value);
      if (!reserved) {
        throw errors.itemAlreadyExists('email', { email: value });
      }
      reservedThisCall.push(value);
      await container.createEmailEvent(ctx.userId, {
        value,
        primary: false,
        status: C.STATUS_PENDING,
        verifiedAt: null,
        verificationMethod: null
      }, ctx.accessId);
      createdThisCall.push(value);
      count++;
    }
  } catch (err) {
    // Roll back only what this call reserved/created.
    for (const value of createdThisCall) {
      const ev = await container.findRawByValue(ctx.userId, value);
      if (ev != null) await container.deleteEmailEvent(ctx.userId, ev);
    }
    for (const value of reservedThisCall) {
      await container.releaseRow(ctx.username, value);
    }
    throw err;
  }
}

/** remove: refuse the primary; release the row + delete the event per value. */
async function removeEmails (deps: Deps, ctx: UserContext, values: string[]): Promise<void> {
  const errors = deps.errors;
  await ensureSeeded(ctx.userId, ctx.legacyEmail);
  for (const value of values) {
    const ev = await container.findRawByValue(ctx.userId, value);
    if (ev == null) {
      throw errors.invalidOperation('This email is not registered on the account.', { email: value });
    }
    if (ev.content.primary === true) {
      throw errors.invalidOperation('The primary email cannot be removed.', { email: value });
    }
    await container.releaseRow(ctx.username, value);
    await container.deleteEmailEvent(ctx.userId, ev);
  }
}

/**
 * setPrimary: the target must exist and be verified. Swaps the legacy singular
 * field (byte-identical to the legacy path), keeps the old primary as a
 * verified non-primary, and re-reserves the old primary's row (the legacy swap
 * released it). Returns true when the legacy email actually changed.
 */
async function setPrimary (deps: Deps, ctx: UserContext, value: string): Promise<boolean> {
  const errors = deps.errors;
  await ensureSeeded(ctx.userId, ctx.legacyEmail);
  const events = await container.getRawEvents(ctx.userId);
  const target = events.find((e) => e.content.value === value);
  if (target == null) {
    throw errors.invalidOperation('This email is not registered on the account.', { email: value });
  }
  if (target.content.status !== C.STATUS_VERIFIED) {
    throw errors.invalidOperation('Only a verified email can be set as primary.', { email: value });
  }
  if (target.content.primary === true) return false; // already primary

  const current = events.find((e) => e.content.primary === true) ?? null;
  const oldValue = current != null ? current.content.value : ctx.legacyEmail;

  await legacyEmailSwap(deps, ctx, oldValue, value);
  if (oldValue != null && oldValue !== value) {
    await container.reserveRow(ctx.username, oldValue); // stays in container
  }
  if (current != null) await container.setContent(ctx.userId, current, { primary: false });
  await container.setContent(ctx.userId, target, { primary: true });
  return true;
}

/**
 * Legacy `account.update {email}` container sync. The legacy path already
 * swapped the singular field and its row; here we mirror the change into the
 * container: promote or create the new value as primary+verified, keep the old
 * primary as a verified non-primary (re-reserving its row), and drop the oldest
 * non-primary if that would exceed the cap.
 */
async function reconcileLegacyPrimaryChange (deps: Deps, ctx: UserContext, oldValue: string | null, newValue: string): Promise<void> {
  if (newValue == null || newValue === oldValue) return;
  await container.ensureContainerStream(ctx.userId);

  let events = await container.getRawEvents(ctx.userId);
  if (events.length === 0 && oldValue != null) {
    // Reconstruct the prior primary so the record is not silently lost. Its
    // row was released by the legacy swap, so re-reserve it.
    await container.reserveRow(ctx.username, oldValue);
    await container.createEmailEvent(ctx.userId, {
      value: oldValue,
      primary: true,
      status: C.STATUS_VERIFIED,
      verifiedAt: null,
      verificationMethod: null
    }, ctx.accessId);
    events = await container.getRawEvents(ctx.userId);
  }

  const existingNew = events.find((e) => e.content.value === newValue) ?? null;
  if (existingNew != null) {
    const wasVerified = existingNew.content.status === C.STATUS_VERIFIED;
    await container.setContent(ctx.userId, existingNew, {
      primary: true,
      status: C.STATUS_VERIFIED,
      verifiedAt: wasVerified ? existingNew.content.verifiedAt : timestamp.now(),
      verificationMethod: wasVerified ? existingNew.content.verificationMethod : null
    }, ctx.accessId);
  } else {
    // The new value's row is already owned (reserved by the legacy swap).
    await container.createEmailEvent(ctx.userId, {
      value: newValue,
      primary: true,
      status: C.STATUS_VERIFIED,
      verifiedAt: null,
      verificationMethod: null
    }, ctx.accessId);
  }

  // Demote every other primary; keep them verified. Re-reserve the old
  // primary's row since it stays in the container.
  events = await container.getRawEvents(ctx.userId);
  for (const e of events) {
    if (e.content.value === newValue) continue;
    if (e.content.primary === true) {
      await container.setContent(ctx.userId, e, { primary: false, status: C.STATUS_VERIFIED }, ctx.accessId);
    }
    if (e.content.value === oldValue) {
      await container.reserveRow(ctx.username, oldValue);
    }
  }

  // Enforce the cap: drop the oldest non-primary rather than fail.
  const max = await container.getMaxEmails();
  let all = await container.getRawEvents(ctx.userId);
  while (all.length > max) {
    const nonPrimary = all
      .filter((e) => e.content.primary !== true)
      .sort((a, b) => ((a.time as number) ?? 0) - ((b.time as number) ?? 0));
    if (nonPrimary.length === 0) break;
    const oldest = nonPrimary[0];
    await container.releaseRow(ctx.username, oldest.content.value);
    await container.deleteEmailEvent(ctx.userId, oldest);
    all = await container.getRawEvents(ctx.userId);
  }
}

export {
  addEmails,
  removeEmails,
  setPrimary,
  reconcileLegacyPrimaryChange,
  ensureSeeded
};
export type { Deps, UserContext };
