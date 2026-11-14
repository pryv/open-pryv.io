/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Time buckets of an audit summary, in the caller's time zone.
 *
 * The audit store groups its rows by fixed UTC slots (`floor(time /
 * slotSeconds)`) and knows nothing of time zones or method classes. This
 * module builds the local hour / day / week boundaries of a range, picks a slot
 * size that never straddles a boundary, and folds the store's groups into one
 * dense bucket per boundary interval. Doing it once, above the engines, keeps
 * PostgreSQL and SQLite answers identical.
 *
 * Boundaries (Unix seconds, ascending):
 * - hour: every instant whose local wall time is at an exact hour, plus the
 *   first instant after a daylight-saving jump that skipped an hour mark. In a
 *   zone that shifts by 30 minutes (Australia/Lord_Howe) an hour can then last
 *   30 or 90 minutes; in a whole-hour zone every hour lasts 3600 s (a fall-back
 *   day has 25 hourly buckets).
 * - day: local midnight (or the first instant of the local date when midnight
 *   falls in a daylight-saving gap). The next one is the local midnight of
 *   (previous + 26 h): a local day lasts 23 to 25 hours, so adding 86 400 s
 *   would stall on a 25-hour day.
 * - week: local midnight of Monday (ISO week); the next one is the local
 *   midnight of (previous + 6 days + 26 h).
 */

import { classifyMethod } from '../accesses/methodClasses.ts';

/** Most buckets one summary may span (31 days hourly, 2 years daily, 14 years weekly). */
export const MAX_BUCKETS = 750;

export type SummaryBucketUnit = 'hour' | 'day' | 'week';
export type SlotSeconds = 3600 | 900;

export type BoundariesParams = {
  fromTime: number;
  toTime: number;
  bucket: SummaryBucketUnit;
  timezone?: string;
};

export type Boundaries = {
  /** B[0] <= fromTime < ... ; B[n] is the first boundary >= toTime; n buckets. */
  boundaries: number[];
  /** 3600 when every boundary is a whole UTC hour, else 900. */
  slotSeconds: SlotSeconds;
};

export type SummaryGroup = {
  /** floor(time / slotSeconds) */
  slot: number;
  /** the row's `content.action` (method id); null when absent */
  action: string | null | undefined;
  /** true (or 1) for rows of type `audit-log/pryv-api-error` */
  error: boolean | number;
  count: number;
};

export type SummaryBucket = {
  time: number;
  total: number;
  reads: number;
  writes: number;
  session: number;
  other: number;
  errors: number;
};

/** Thrown when a range spans more than MAX_BUCKETS buckets. */
export class BucketCapError extends Error {
  readonly code = 'too-many-buckets';
  readonly maxBuckets = MAX_BUCKETS;
  constructor (bucket: SummaryBucketUnit) {
    super(`The range spans more than ${MAX_BUCKETS} ${bucket} buckets; ask for a shorter range.`);
    this.name = 'BucketCapError';
  }
}

const UNIT_SECONDS: Record<SummaryBucketUnit, number> = { hour: 3600, day: 86400, week: 604800 };
const HOUR = 3600;
const DAY_STEP = 26 * HOUR;
const WEEK_STEP = 6 * 86400 + 26 * HOUR;
/** Largest Unix time (seconds) a JS Date can represent. */
const MAX_DATE_SECONDS = 8.64e12;

export function isValidTimeZone (tz: unknown): boolean {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Local wall time

const FORMATTER_CACHE_MAX = 64;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor (tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (f == null) {
    if (formatters.size >= FORMATTER_CACHE_MAX) formatters.clear();
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric'
    });
    formatters.set(tz, f);
  }
  return f;
}

type Wall = { y: number; mo: number; d: number; h: number; mi: number; s: number };

/** Local wall time of the instant `t` (whole Unix seconds) in `tz`. */
function wallOf (tz: string, t: number): Wall {
  const w: Wall = { y: 0, mo: 0, d: 0, h: 0, mi: 0, s: 0 };
  for (const part of formatterFor(tz).formatToParts(new Date(t * 1000))) {
    switch (part.type) {
      case 'year': w.y = Number(part.value); break;
      case 'month': w.mo = Number(part.value); break;
      case 'day': w.d = Number(part.value); break;
      case 'hour': w.h = Number(part.value) % 24; break;
      case 'minute': w.mi = Number(part.value); break;
      case 'second': w.s = Number(part.value); break;
    }
  }
  return w;
}

/** Wall time expressed as if it were UTC, in seconds. */
function wallSeconds (w: Wall): number {
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) / 1000;
}

/** UTC offset of `tz` at instant `t`, in seconds (wall - instant). */
function offsetAt (tz: string, t: number): number {
  return wallSeconds(wallOf(tz, t)) - t;
}

function mod (a: number, m: number): number {
  return ((a % m) + m) % m;
}

/** Smallest instant in (lo, hi] whose offset differs from `oLo` (offset at lo). */
function firstTransition (tz: string, lo: number, hi: number, oLo: number): number {
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsetAt(tz, mid) === oLo) lo = mid;
    else hi = mid;
  }
  return hi;
}

// ---------------------------------------------------------------------------
// Hours

/** First hour boundary strictly after `b`. */
function nextHourBoundary (tz: string, b: number): number {
  const o1 = offsetAt(tz, b);
  const mark = b + HOUR - mod(b + o1, HOUR);
  if (offsetAt(tz, mark) === o1) return mark;
  const T = firstTransition(tz, b, mark, o1);
  const o2 = offsetAt(tz, T);
  if (o2 > o1) {
    // The wall jumps forward from T + o1 to T + o2: an hour mark in that gap
    // makes T the first instant of a new local hour.
    const lastMarkAtT = (T + o2) - mod(T + o2, HOUR);
    if (lastMarkAtT >= T + o1) return T;
  }
  const next = T + mod(-(T + o2), HOUR);
  if (next === T || offsetAt(tz, next) === o2) return next;
  return nextHourBoundary(tz, T); // another transition before the mark
}

/** Hour boundary at or before `t` (hours last at most 90 minutes). */
function startOfHourContaining (tz: string, t: number): number {
  let b = nextHourBoundary(tz, t - 3 * HOUR);
  for (let n = nextHourBoundary(tz, b); n <= t; n = nextHourBoundary(tz, b)) b = n;
  return b;
}

// ---------------------------------------------------------------------------
// Days and weeks

/**
 * First instant of the local date whose midnight, written as UTC, is `W`
 * (seconds). `near` is an instant within a day or so of it. When midnight
 * occurs twice, the earlier; when it falls in a gap, the end of the gap.
 */
function instantOfLocalMidnight (tz: string, W: number, near: number): number {
  const s0 = W - offsetAt(tz, near);
  const offsets = new Set([
    offsetAt(tz, near),
    offsetAt(tz, s0),
    offsetAt(tz, s0 - 6 * HOUR),
    offsetAt(tz, s0 + 6 * HOUR)
  ]);
  let best = Infinity;
  let lo = Infinity;
  let hi = -Infinity;
  for (const o of offsets) {
    const s = W - o;
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
    if (offsetAt(tz, s) === o && s < best) best = s;
  }
  if (best !== Infinity) return best;
  // Midnight does not exist: the first instant whose wall time is >= W.
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (mid + offsetAt(tz, mid) >= W) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** First instant of the local day containing `t`. */
function startOfDayContaining (tz: string, t: number): number {
  const w = wallOf(tz, t);
  return instantOfLocalMidnight(tz, Date.UTC(w.y, w.mo - 1, w.d) / 1000, t);
}

/** First instant of the local ISO week (Monday) containing `t`. */
function startOfWeekContaining (tz: string, t: number): number {
  const w = wallOf(tz, t);
  const dayIndex = (new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay() + 6) % 7; // Monday = 0
  const W = Date.UTC(w.y, w.mo - 1, w.d - dayIndex) / 1000;
  return instantOfLocalMidnight(tz, W, t - dayIndex * 86400);
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Boundaries of the `bucket` intervals covering [fromTime, toTime) in
 * `timezone`. Throws BucketCapError beyond MAX_BUCKETS (checked before the
 * list is built), RangeError on an invalid argument.
 */
export function buildBoundaries ({ fromTime, toTime, bucket, timezone = 'UTC' }: BoundariesParams): Boundaries {
  if (!Object.hasOwn(UNIT_SECONDS, bucket)) throw new RangeError(`Unknown bucket "${String(bucket)}"`);
  if (!isValidTimeZone(timezone)) throw new RangeError(`Unknown time zone "${String(timezone)}"`);
  if (!Number.isFinite(fromTime) || Math.abs(fromTime) > MAX_DATE_SECONDS) throw new RangeError('Invalid fromTime');
  if (!Number.isFinite(toTime) || toTime <= fromTime) throw new RangeError('toTime must be after fromTime');

  const from = Math.floor(fromTime);
  const first = bucket === 'hour'
    ? startOfHourContaining(timezone, from)
    : bucket === 'day' ? startOfDayContaining(timezone, from) : startOfWeekContaining(timezone, from);

  // Units differ from their nominal length by at most a fraction of one unit
  // over a capped range: refuse early, without walking a huge range.
  if ((toTime - first) / UNIT_SECONDS[bucket] > MAX_BUCKETS + 2) throw new BucketCapError(bucket);

  const boundaries = [first];
  let last = first;
  while (last < toTime) {
    if (boundaries.length > MAX_BUCKETS) throw new BucketCapError(bucket);
    const next = bucket === 'hour'
      ? nextHourBoundary(timezone, last)
      : startOfDayContaining(timezone, last + (bucket === 'day' ? DAY_STEP : WEEK_STEP));
    if (!(next > last)) throw new Error(`Bucket boundaries did not advance at ${last} (${timezone})`);
    boundaries.push(next);
    last = next;
  }

  const slotSeconds: SlotSeconds = boundaries.every((b) => mod(b, HOUR) === 0) ? 3600 : 900;
  return { boundaries, slotSeconds };
}

/** Index i of the bucket with boundaries[i] <= t < boundaries[i + 1], or -1. */
function bucketIndex (boundaries: number[], t: number): number {
  const n = boundaries.length - 1;
  if (n < 1 || t < boundaries[0] || t >= boundaries[n]) return -1;
  let lo = 0;
  let hi = n; // boundaries[lo] <= t < boundaries[hi]
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (boundaries[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Folds the audit store's groups into dense buckets, one per interval of
 * `boundaries`, ascending. Rows are counted by the class of their method id
 * (`classifyMethod`), whatever their outcome; a missing or unknown method id
 * counts as `other`; `callBatch` rows are dropped from every figure, errors
 * included. `errors` is an overlay over the classes; `total` is the sum of the
 * four classes.
 */
export function foldGroups (
  groups: Iterable<SummaryGroup>,
  { boundaries, slotSeconds, fromTime, toTime }: { boundaries: number[]; slotSeconds: number; fromTime: number; toTime: number }
): SummaryBucket[] {
  const buckets: SummaryBucket[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    buckets.push({ time: boundaries[i], total: 0, reads: 0, writes: 0, session: 0, other: 0, errors: 0 });
  }
  for (const group of groups) {
    const count = Number(group.count);
    if (!Number.isFinite(count) || count <= 0) continue;
    const slotStart = Number(group.slot) * slotSeconds;
    if (!Number.isFinite(slotStart) || slotStart + slotSeconds <= fromTime || slotStart >= toTime) continue;
    const index = bucketIndex(boundaries, Math.max(slotStart, fromTime));
    if (index < 0) continue;
    const cls = typeof group.action === 'string' && group.action.length > 0 ? classifyMethod(group.action) : 'other';
    if (cls === 'batch') continue;
    const bucket = buckets[index];
    if (cls === 'read') bucket.reads += count;
    else if (cls === 'write') bucket.writes += count;
    else if (cls === 'session') bucket.session += count;
    else bucket.other += count;
    bucket.total += count;
    if (group.error === true || group.error === 1) bucket.errors += count;
  }
  return buckets;
}
