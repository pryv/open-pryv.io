/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Helpers of `bin/hfs-duration-repair.js`: find the series events whose
 * `duration` holds the data extent in nanoseconds (written by releases before
 * 2.0.0-rc.40) and set it to the extent in seconds, read from the series data.
 *
 * A candidate is a series event that ends more than a day in the future: the
 * metadata flush only ever wrote the extent of points already stored, so a
 * duration it wrote cannot end in the future. Each candidate is checked
 * against its series: the maximum deltaTime at or after the candidate extent
 * is the value to write; no point there means the duration did not come from
 * this data, and the event is reported, not rewritten.
 */

export const FUTURE_MARGIN_S = 86400;
export const NANOS_PER_SECOND = 1e9;
/** The extent is looked up from 1 ms under it: query bounds are truncated to the millisecond. */
export const EXTENT_TOLERANCE_S = 1e-3;
export const EXACT_TOLERANCE_S = 1e-6;

type EventLike = {
  id: string;
  type?: unknown;
  time?: unknown;
  duration?: unknown;
  [key: string]: unknown;
};

type SeriesRow = { get (field: string): unknown };
type SeriesData = { eachRow (cb: (row: SeriesRow) => void): void };
type SeriesLike = { query (query: { from?: number }): Promise<SeriesData> };
type SeriesRepoLike = { get (namespace: string, name: string): Promise<SeriesLike> };
type MallLike = {
  events: {
    get (userId: string, query: Record<string, unknown>): Promise<EventLike[]>;
    updateWithMerge (
      userId: string,
      fullEventId: string,
      merge: (stored: EventLike) => EventLike | null,
      mallTransaction?: unknown,
      opts?: { skipVersioning?: boolean }
    ): Promise<EventLike | null>;
  };
};

export type Classification =
  | { kind: 'legit' }
  | { kind: 'unexplained' }
  | { kind: 'repair'; duration: number; exact: boolean };

/** A series event with a positive duration that ends more than a day after `now`. */
export function isCandidate (event: EventLike, now: number): boolean {
  return typeof event.type === 'string' && event.type.startsWith('series:') &&
    typeof event.time === 'number' &&
    typeof event.duration === 'number' && Number.isFinite(event.duration) && event.duration > 0 &&
    event.time + event.duration > now + FUTURE_MARGIN_S;
}

/**
 * `duration`: the stored duration (seconds); `m`: the series' maximum
 * deltaTime at or after the candidate extent (seconds), or null when none.
 */
export function classify (duration: number, m: number | null): Classification {
  if (m == null) return { kind: 'unexplained' };
  if (m >= duration - EXTENT_TOLERANCE_S) return { kind: 'legit' };
  const candidate = duration / NANOS_PER_SECOND;
  return { kind: 'repair', duration: m, exact: Math.abs(m - candidate) <= EXACT_TOLERANCE_S };
}

/** Maximum deltaTime (seconds) of the series points at or after `fromSeconds`, or null. */
export async function seriesMaxDelta (series: SeriesLike, fromSeconds: number): Promise<number | null> {
  const data = await series.query(fromSeconds > 0 ? { from: fromSeconds } : {});
  let max: number | null = null;
  data.eachRow((row) => {
    const delta = Number(row.get('deltaTime'));
    if (Number.isFinite(delta) && (max == null || delta > max)) max = delta;
  });
  return max;
}

export type UserRepairResult = {
  candidates: number;
  repaired: number;
  exact: number;
  grown: number;
  legit: number;
  unexplained: string[];
  skippedChanged: number;
};

/** Finds and (unless `dryRun`) repairs the oversized series durations of one user. */
export async function repairUserSeriesDurations ({ mall, seriesRepo, seriesNamespace, userId, username, now, dryRun }: {
  mall: MallLike;
  seriesRepo: SeriesRepoLike;
  seriesNamespace: string;
  userId: string;
  username: string;
  now: number;
  dryRun: boolean;
}): Promise<UserRepairResult> {
  const result: UserRepairResult = { candidates: 0, repaired: 0, exact: 0, grown: 0, legit: 0, unexplained: [], skippedChanged: 0 };
  const events = await mall.events.get(userId, { state: 'all', fromTime: now + FUTURE_MARGIN_S, limit: 1_000_000 });
  for (const event of (events || [])) {
    if (!isCandidate(event, now)) continue;
    result.candidates++;
    const duration = event.duration as number;
    const series = await seriesRepo.get(seriesNamespace, 'event.' + event.id);
    const m = await seriesMaxDelta(series, duration / NANOS_PER_SECOND - EXTENT_TOLERANCE_S);
    const verdict = classify(duration, m);
    if (verdict.kind === 'legit') { result.legit++; continue; }
    if (verdict.kind === 'unexplained') { result.unexplained.push(username + '/' + event.id); continue; }
    if (dryRun) {
      result.repaired++;
      if (verdict.exact) result.exact++; else result.grown++;
      continue;
    }
    const written = await mall.events.updateWithMerge(userId, event.id, (stored) => {
      // Changed since it was read (a client edit or a flush): leave it to a re-run.
      if (!(typeof stored.duration === 'number' && Math.abs(stored.duration - duration) <= EXTENT_TOLERANCE_S)) return null;
      return { ...stored, duration: verdict.duration, modified: Date.now() / 1000 };
    }, null, { skipVersioning: true });
    if (written == null) { result.skippedChanged++; continue; }
    result.repaired++;
    if (verdict.exact) result.exact++; else result.grown++;
  }
  return result;
}
