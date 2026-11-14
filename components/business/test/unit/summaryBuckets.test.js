/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Bucket boundaries of an audit summary in the caller's time zone, and the
 * folding of the audit store's slot groups into dense buckets.
 */

const assert = require('node:assert/strict');
const {
  MAX_BUCKETS, BucketCapError, isValidTimeZone, buildBoundaries, foldGroups
} = require('../../src/audit/summaryBuckets.ts');

const utc = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000;

/** Local wall time of `t` in `tz`, as 'YYYY-MM-DD HH:mm' plus the weekday. */
function local (tz, t) {
  const parts = {};
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  for (const p of f.formatToParts(new Date(t * 1000))) parts[p.type] = p.value;
  return { text: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`, weekday: parts.weekday, hm: `${parts.hour}:${parts.minute}` };
}

const lengths = (boundaries) => boundaries.slice(1).map((b, i) => b - boundaries[i]);

describe('[ASB] audit summary buckets', function () {
  describe('[ASB1] UTC', function () {
    it('[ASB1A] hour: first bucket starts at the hour containing fromTime, last boundary covers toTime', function () {
      const r = buildBoundaries({ fromTime: utc(2026, 1, 5, 10, 30), toTime: utc(2026, 1, 5, 13), bucket: 'hour', timezone: 'UTC' });
      assert.deepEqual(r.boundaries, [utc(2026, 1, 5, 10), utc(2026, 1, 5, 11), utc(2026, 1, 5, 12), utc(2026, 1, 5, 13)]);
      assert.equal(r.slotSeconds, 3600);
    });

    it('[ASB1B] day: midnights, toTime just past a midnight opens one more bucket', function () {
      const r = buildBoundaries({ fromTime: utc(2026, 1, 5, 10, 30), toTime: utc(2026, 1, 7) + 1, bucket: 'day', timezone: 'UTC' });
      assert.deepEqual(r.boundaries, [utc(2026, 1, 5), utc(2026, 1, 6), utc(2026, 1, 7), utc(2026, 1, 8)]);
      assert.equal(r.slotSeconds, 3600);
    });

    it('[ASB1C] week: starts on Monday', function () {
      // 2026-01-08 is a Thursday
      const r = buildBoundaries({ fromTime: utc(2026, 1, 8, 12), toTime: utc(2026, 1, 20), bucket: 'week' });
      assert.deepEqual(r.boundaries, [utc(2026, 1, 5), utc(2026, 1, 12), utc(2026, 1, 19), utc(2026, 1, 26)]);
      for (const b of r.boundaries) assert.equal(new Date(b * 1000).getUTCDay(), 1);
      assert.equal(r.slotSeconds, 3600);
    });

    it('[ASB1D] fromTime on a boundary starts there; fractional times are accepted', function () {
      const r = buildBoundaries({ fromTime: utc(2026, 1, 5), toTime: utc(2026, 1, 6), bucket: 'day', timezone: 'UTC' });
      assert.deepEqual(r.boundaries, [utc(2026, 1, 5), utc(2026, 1, 6)]);
      const f = buildBoundaries({ fromTime: utc(2026, 1, 5) + 0.5, toTime: utc(2026, 1, 5, 1) + 0.25, bucket: 'hour', timezone: 'UTC' });
      assert.deepEqual(f.boundaries, [utc(2026, 1, 5), utc(2026, 1, 5, 1), utc(2026, 1, 5, 2)]);
    });

    it('[ASB1E] time zone names are checked', function () {
      assert.equal(isValidTimeZone('UTC'), true);
      assert.equal(isValidTimeZone('Europe/Zurich'), true);
      assert.equal(isValidTimeZone('Mars/Olympus'), false);
      assert.equal(isValidTimeZone(''), false);
      assert.equal(isValidTimeZone(42), false);
      assert.throws(() => buildBoundaries({ fromTime: 0, toTime: 3600, bucket: 'hour', timezone: 'Mars/Olympus' }), RangeError);
      assert.throws(() => buildBoundaries({ fromTime: 3600, toTime: 3600, bucket: 'hour' }), RangeError);
      assert.throws(() => buildBoundaries({ fromTime: 0, toTime: 3600, bucket: 'month' }), RangeError);
    });
  });

  describe('[ASB2] Europe/Zurich across daylight-saving changes', function () {
    const tz = 'Europe/Zurich';

    it('[ASB2A] spring: a 23-hour local day', function () {
      const r = buildBoundaries({ fromTime: utc(2026, 3, 28, 6), toTime: utc(2026, 3, 30, 12), bucket: 'day', timezone: tz });
      assert.deepEqual(r.boundaries, [utc(2026, 3, 27, 23), utc(2026, 3, 28, 23), utc(2026, 3, 29, 22), utc(2026, 3, 30, 22)]);
      assert.deepEqual(lengths(r.boundaries), [24 * 3600, 23 * 3600, 24 * 3600]);
      for (const b of r.boundaries) assert.equal(local(tz, b).hm, '00:00');
      assert.equal(r.slotSeconds, 3600);
    });

    it('[ASB2B] autumn: a 25-hour local day', function () {
      const r = buildBoundaries({ fromTime: utc(2026, 10, 24, 6), toTime: utc(2026, 10, 26, 12), bucket: 'day', timezone: tz });
      assert.deepEqual(r.boundaries, [utc(2026, 10, 23, 22), utc(2026, 10, 24, 22), utc(2026, 10, 25, 23), utc(2026, 10, 26, 23)]);
      assert.deepEqual(lengths(r.boundaries), [24 * 3600, 25 * 3600, 24 * 3600]);
      for (const b of r.boundaries) assert.equal(local(tz, b).hm, '00:00');
      assert.equal(r.slotSeconds, 3600);
    });

    it('[ASB2C] hourly buckets: 23 on the spring day, 25 on the autumn day, each 3600 s', function () {
      const spring = buildBoundaries({ fromTime: utc(2026, 3, 28, 23), toTime: utc(2026, 3, 29, 22), bucket: 'hour', timezone: tz });
      assert.equal(spring.boundaries.length - 1, 23);
      assert.ok(lengths(spring.boundaries).every((l) => l === 3600));
      assert.ok(!spring.boundaries.map((b) => local(tz, b).hm).includes('02:00'));
      const autumn = buildBoundaries({ fromTime: utc(2026, 10, 24, 22), toTime: utc(2026, 10, 25, 23), bucket: 'hour', timezone: tz });
      assert.equal(autumn.boundaries.length - 1, 25);
      assert.ok(lengths(autumn.boundaries).every((l) => l === 3600));
      assert.equal(autumn.boundaries.filter((b) => local(tz, b).hm === '02:00').length, 2);
      assert.equal(spring.slotSeconds, 3600);
      assert.equal(autumn.slotSeconds, 3600);
    });

    it('[ASB2D] weeks start on local Monday midnight, 167 h and 169 h across the changes', function () {
      const spring = buildBoundaries({ fromTime: utc(2026, 3, 25), toTime: utc(2026, 4, 1), bucket: 'week', timezone: tz });
      assert.deepEqual(spring.boundaries.slice(0, 2), [utc(2026, 3, 22, 23), utc(2026, 3, 29, 22)]);
      assert.equal(lengths(spring.boundaries)[0], 167 * 3600);
      const autumn = buildBoundaries({ fromTime: utc(2026, 10, 21), toTime: utc(2026, 10, 28), bucket: 'week', timezone: tz });
      assert.deepEqual(autumn.boundaries.slice(0, 2), [utc(2026, 10, 18, 22), utc(2026, 10, 25, 23)]);
      assert.equal(lengths(autumn.boundaries)[0], 169 * 3600);
      for (const b of [...spring.boundaries, ...autumn.boundaries]) {
        assert.equal(local(tz, b).weekday, 'Mon');
        assert.equal(local(tz, b).hm, '00:00');
      }
    });

    it('[ASB2E] a full year of local days: 365 midnights, one 23 h and one 25 h day', function () {
      const r = buildBoundaries({ fromTime: utc(2026, 1, 1), toTime: utc(2026, 12, 31, 23), bucket: 'day', timezone: tz });
      assert.equal(r.boundaries.length - 1, 365);
      const l = lengths(r.boundaries);
      assert.equal(l.filter((x) => x === 23 * 3600).length, 1);
      assert.equal(l.filter((x) => x === 25 * 3600).length, 1);
      assert.equal(l.filter((x) => x === 24 * 3600).length, 363);
      for (const b of r.boundaries) assert.equal(local(tz, b).hm, '00:00');
    });
  });

  describe('[ASB3] Asia/Kolkata (UTC+5:30)', function () {
    const tz = 'Asia/Kolkata';

    it('[ASB3A] day: local midnights at 18:30 UTC, slot 900', function () {
      const r = buildBoundaries({ fromTime: utc(2026, 1, 5, 6), toTime: utc(2026, 1, 7, 6), bucket: 'day', timezone: tz });
      assert.deepEqual(r.boundaries, [utc(2026, 1, 4, 18, 30), utc(2026, 1, 5, 18, 30), utc(2026, 1, 6, 18, 30), utc(2026, 1, 7, 18, 30)]);
      for (const b of r.boundaries) assert.equal(local(tz, b).hm, '00:00');
      assert.equal(r.slotSeconds, 900);
    });

    it('[ASB3B] hour: boundaries at half past UTC hours, slot 900', function () {
      const r = buildBoundaries({ fromTime: utc(2026, 1, 5, 6, 10), toTime: utc(2026, 1, 5, 8), bucket: 'hour', timezone: tz });
      assert.deepEqual(r.boundaries, [utc(2026, 1, 5, 5, 30), utc(2026, 1, 5, 6, 30), utc(2026, 1, 5, 7, 30), utc(2026, 1, 5, 8, 30)]);
      assert.equal(r.slotSeconds, 900);
    });

    it('[ASB3C] Asia/Kathmandu (UTC+5:45): slot 900 still aligns', function () {
      const r = buildBoundaries({ fromTime: utc(2026, 1, 5, 6), toTime: utc(2026, 1, 7, 6), bucket: 'day', timezone: 'Asia/Kathmandu' });
      for (const b of r.boundaries) {
        assert.equal(local('Asia/Kathmandu', b).hm, '00:00');
        assert.equal(b % 900, 0);
      }
      assert.equal(r.slotSeconds, 900);
    });
  });

  describe('[ASB4] bucket cap', function () {
    it('[ASB4A] 750 buckets pass, 751 are refused', function () {
      const from = utc(2026, 1, 1);
      const ok = buildBoundaries({ fromTime: from, toTime: from + MAX_BUCKETS * 3600, bucket: 'hour' });
      assert.equal(MAX_BUCKETS, 750);
      assert.equal(ok.boundaries.length - 1, 750);
      assert.throws(() => buildBoundaries({ fromTime: from, toTime: from + 750 * 3600 + 1, bucket: 'hour' }),
        (err) => err instanceof BucketCapError && err.code === 'too-many-buckets' && err.maxBuckets === 750);
      const zurichMidnight = utc(2025, 12, 31, 23); // 2026-01-01 00:00 local; 750 days later is winter time again
      const days = buildBoundaries({ fromTime: zurichMidnight, toTime: zurichMidnight + 750 * 86400, bucket: 'day', timezone: 'Europe/Zurich' });
      assert.equal(days.boundaries.length - 1, 750);
      assert.throws(() => buildBoundaries({ fromTime: zurichMidnight, toTime: zurichMidnight + 750 * 86400 + 1, bucket: 'day', timezone: 'Europe/Zurich' }), BucketCapError);
      assert.throws(() => buildBoundaries({ fromTime: from, toTime: from + 751 * 7 * 86400, bucket: 'week' }), BucketCapError);
    });

    it('[ASB4B] a 100-year hourly range is refused at once', function () {
      const start = Date.now();
      assert.throws(() => buildBoundaries({ fromTime: 0, toTime: 100 * 365 * 86400, bucket: 'hour', timezone: 'Europe/Zurich' }), BucketCapError);
      assert.throws(() => buildBoundaries({ fromTime: 0, toTime: 1e15, bucket: 'day', timezone: 'Asia/Kolkata' }), BucketCapError);
      assert.ok(Date.now() - start < 50, `took ${Date.now() - start} ms`);
    });
  });

  describe('[ASB5] folding groups into buckets', function () {
    it('[ASB5A] classes, callBatch dropped, missing action as other, errors overlay, dense', function () {
      const fromTime = utc(2026, 1, 5, 12);
      const toTime = utc(2026, 1, 8);
      const b = buildBoundaries({ fromTime, toTime, bucket: 'day', timezone: 'UTC' });
      const slot = (t) => Math.floor(t / b.slotSeconds);
      const groups = [
        { slot: slot(utc(2026, 1, 5, 13)), action: 'events.get', error: false, count: 5 },
        { slot: slot(utc(2026, 1, 5, 13)), action: 'events.get', error: true, count: 2 },
        { slot: slot(utc(2026, 1, 5, 20)), action: 'events.create', error: 1, count: 1 },
        { slot: slot(utc(2026, 1, 5, 20)), action: 'auth.login', error: 0, count: 3 },
        { slot: slot(utc(2026, 1, 5, 21)), action: 'callBatch', error: true, count: 4 },
        { slot: slot(utc(2026, 1, 7, 1)), action: null, error: false, count: 1 },
        { slot: slot(utc(2026, 1, 7, 1)), action: 'some.unknownThing', error: true, count: 2 },
        { slot: slot(utc(2026, 1, 7, 2)), action: 'accesses.update', error: false, count: 6 }
      ];
      const out = foldGroups(groups, { ...b, fromTime, toTime });
      assert.deepEqual(out, [
        { time: utc(2026, 1, 5), total: 11, reads: 7, writes: 1, session: 3, other: 0, errors: 3 },
        { time: utc(2026, 1, 6), total: 0, reads: 0, writes: 0, session: 0, other: 0, errors: 0 },
        { time: utc(2026, 1, 7), total: 9, reads: 0, writes: 6, session: 0, other: 3, errors: 2 }
      ]);
      for (const x of out) assert.equal(x.total, x.reads + x.writes + x.session + x.other);
    });

    it('[ASB5B] slots land in the local bucket (Zurich 3600, Kolkata 900); out-of-range slots ignored', function () {
      const zFrom = utc(2026, 10, 24, 6);
      const zTo = utc(2026, 10, 26, 6);
      const z = buildBoundaries({ fromTime: zFrom, toTime: zTo, bucket: 'day', timezone: 'Europe/Zurich' });
      const zOut = foldGroups([
        { slot: utc(2026, 10, 24, 21) / 3600, action: 'events.get', error: false, count: 1 }, // 23:00 local, 24th
        { slot: utc(2026, 10, 24, 22) / 3600, action: 'events.get', error: false, count: 2 }, // 00:00 local, 25th
        { slot: utc(2026, 10, 25, 22) / 3600, action: 'events.get', error: false, count: 4 }, // 23:00 local, 25th (25 h day)
        { slot: utc(2026, 10, 25, 23) / 3600, action: 'events.get', error: false, count: 8 }, // 00:00 local, 26th
        { slot: utc(2026, 10, 26, 6) / 3600, action: 'events.get', error: false, count: 16 } // at toTime: ignored
      ], { ...z, fromTime: zFrom, toTime: zTo });
      assert.deepEqual(zOut.map((x) => x.reads), [1, 6, 8]);

      const kFrom = utc(2026, 1, 5);
      const kTo = utc(2026, 1, 6);
      const k = buildBoundaries({ fromTime: kFrom, toTime: kTo, bucket: 'day', timezone: 'Asia/Kolkata' });
      assert.equal(k.slotSeconds, 900);
      const kOut = foldGroups([
        { slot: utc(2026, 1, 5, 18, 15) / 900, action: 'events.create', error: false, count: 1 },
        { slot: utc(2026, 1, 5, 18, 30) / 900, action: 'events.create', error: false, count: 2 },
        { slot: utc(2026, 1, 4, 23) / 900, action: 'events.create', error: false, count: 32 } // before fromTime: ignored
      ], { ...k, fromTime: kFrom, toTime: kTo });
      assert.deepEqual(kOut.map((x) => [x.time, x.writes]), [[utc(2026, 1, 4, 18, 30), 1], [utc(2026, 1, 5, 18, 30), 2]]);
    });
  });

  describe('[ASB6] other half-hour zones', function () {
    it('[ASB6A] Australia/Lord_Howe: 30-minute shifts give 24.5 h and 23.5 h days, slot 900', function () {
      const tz = 'Australia/Lord_Howe';
      const autumn = buildBoundaries({ fromTime: utc(2026, 4, 4, 0), toTime: utc(2026, 4, 6, 0), bucket: 'day', timezone: tz });
      assert.ok(lengths(autumn.boundaries).includes(24.5 * 3600));
      const spring = buildBoundaries({ fromTime: utc(2026, 10, 3, 0), toTime: utc(2026, 10, 5, 0), bucket: 'day', timezone: tz });
      assert.ok(lengths(spring.boundaries).includes(23.5 * 3600));
      for (const b of [...autumn.boundaries, ...spring.boundaries]) assert.equal(local(tz, b).hm, '00:00');
      assert.equal(autumn.slotSeconds, 900);
    });

    it('[ASB6B] Australia/Lord_Howe hours: the shifted hour lasts 30 or 90 minutes, 24 buckets a day', function () {
      const tz = 'Australia/Lord_Howe';
      for (const [day, odd] of [[{ y: 2026, mo: 4, d: 5 }, 5400], [{ y: 2026, mo: 10, d: 4 }, 1800]]) {
        const days = buildBoundaries({ fromTime: utc(day.y, day.mo, day.d, 0), toTime: utc(day.y, day.mo, day.d, 1), bucket: 'day', timezone: tz });
        const [start, end] = days.boundaries.slice(-2);
        const hours = buildBoundaries({ fromTime: start, toTime: end, bucket: 'hour', timezone: tz });
        assert.equal(hours.boundaries.at(-1), end);
        assert.equal(hours.boundaries.length - 1, 24);
        const l = lengths(hours.boundaries);
        assert.equal(l.filter((x) => x === odd).length, 1);
        assert.equal(l.filter((x) => x === 3600).length, 23);
        assert.equal(hours.slotSeconds, 900);
      }
    });

    it('[ASB6C] America/St_Johns (UTC-3:30 / -2:30): 23 h and 25 h days at local midnight', function () {
      const tz = 'America/St_Johns';
      const r = buildBoundaries({ fromTime: utc(2026, 1, 1, 12), toTime: utc(2026, 12, 31, 12), bucket: 'day', timezone: tz });
      const l = lengths(r.boundaries);
      assert.equal(l.filter((x) => x === 23 * 3600).length, 1);
      assert.equal(l.filter((x) => x === 25 * 3600).length, 1);
      for (const b of r.boundaries) assert.equal(local(tz, b).hm, '00:00');
      assert.equal(r.slotSeconds, 900);
    });

    it('[ASB6D] America/Santiago: when midnight falls in the gap, the day starts at 01:00', function () {
      const tz = 'America/Santiago';
      const r = buildBoundaries({ fromTime: utc(2026, 9, 5, 12), toTime: utc(2026, 9, 7, 12), bucket: 'day', timezone: tz });
      assert.deepEqual(r.boundaries.map((b) => local(tz, b).text), ['2026-09-05 00:00', '2026-09-06 01:00', '2026-09-07 00:00', '2026-09-08 00:00']);
      assert.deepEqual(lengths(r.boundaries), [24 * 3600, 23 * 3600, 24 * 3600]);
    });
  });

  describe('[ASB7] a zone whose offset is not a multiple of 15 minutes', function () {
    it('[ASB7A] Africa/Monrovia in June 1971 (-0:44:30): slot 30, every boundary on a slot, folding equals direct bucketing', function () {
      const tz = 'Africa/Monrovia';
      assert.equal(local(tz, utc(1971, 6, 1)).hm, '23:15', 'this runtime knows the -0:44:30 offset');
      const fromTime = utc(1971, 6, 1);
      const toTime = utc(1971, 7, 1);
      const r = buildBoundaries({ fromTime, toTime, bucket: 'day', timezone: tz });
      assert.equal(r.slotSeconds, 30);
      for (const b of r.boundaries) {
        assert.equal(b % r.slotSeconds, 0);
        assert.equal(local(tz, b).hm, '00:00');
      }
      // Random rows: per-bucket counts from the slot groups equal direct bucketing.
      let seed = 7;
      const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
      const direct = r.boundaries.slice(0, -1).map(() => 0);
      const groups = new Map();
      for (let i = 0; i < 5000; i++) {
        const t = fromTime + Math.floor(random() * (toTime - fromTime) * 10) / 10;
        let index = 0;
        while (r.boundaries[index + 1] <= t) index++;
        direct[index]++;
        const slot = Math.floor(t / r.slotSeconds);
        groups.set(slot, (groups.get(slot) ?? 0) + 1);
      }
      const folded = foldGroups([...groups].map(([slot, count]) => ({ slot, action: 'events.get', error: false, count })),
        { ...r, fromTime, toTime });
      assert.deepEqual(folded.map((b) => b.reads), direct);
      assert.equal(direct.reduce((a, b) => a + b, 0), 5000);
    });

    it('[ASB7B] common zones keep 3600 or 900', function () {
      assert.equal(buildBoundaries({ fromTime: utc(2026, 1, 5), toTime: utc(2026, 1, 9), bucket: 'day', timezone: 'Europe/Zurich' }).slotSeconds, 3600);
      assert.equal(buildBoundaries({ fromTime: utc(2026, 1, 5), toTime: utc(2026, 1, 9), bucket: 'day', timezone: 'Asia/Kathmandu' }).slotSeconds, 900);
    });
  });
});
