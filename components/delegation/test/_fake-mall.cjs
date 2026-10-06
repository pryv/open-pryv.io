/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * `updateWithMerge` for a fake mall `events`: reads the fake's own store
 * (`getOne`, or a scan of `get` for a fake without it), applies the merge and
 * writes through the fake's `update`, so assertions on recorded updates and
 * per-test overrides of `update` keep working. Mirrors
 * the real mall's contract: a missing event throws, a null merge writes
 * nothing and returns null.
 */
async function fakeUpdateWithMerge (events, userId, eventId, merge, transaction, opts) {
  const stored = events.getOne != null
    ? await events.getOne(userId, eventId)
    : ((await events.get(userId, {})) || []).find((e) => e?.id === eventId) ?? null;
  if (stored == null) throw Object.assign(new Error('Could not update event with id ' + eventId), { id: 'invalid-item-id' });
  const next = merge(structuredClone(stored));
  if (next == null) return null;
  return await events.update(userId, { ...next, id: eventId }, transaction, opts);
}

module.exports = { fakeUpdateWithMerge };
