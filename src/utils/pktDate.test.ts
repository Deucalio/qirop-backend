/**
 * Tests for the reporting period window.
 *
 * A yearly report that silently resolves to one month still renders under a
 * "Year XXXX" title, so these assert the span itself rather than trusting the
 * caller. Month-end is the other trap: February and the 30-day months must not
 * lose their last day to a `lte` bound.
 *
 * Run with: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { periodWindow, periodKey, isOnOrBeforePeriod, pktDayBounds } from './pktDate';

const iso = (d: Date) => d.toISOString();

describe('periodWindow — yearly', () => {
  for (const month of [0, null, undefined] as const) {
    test(`month ${String(month)} spans the whole year`, () => {
      const w = periodWindow(2026, month);
      assert.equal(w.isYearly, true);
      assert.equal(iso(w.start), '2026-01-01T00:00:00.000Z');
      assert.equal(iso(w.end), '2026-12-31T23:59:59.000Z');
    });
  }

  test('a yearly window covers all twelve months, not just January', () => {
    const { start, end } = periodWindow(2026, 0);
    const months = new Set<number>();
    for (let m = 0; m < 12; m++) {
      const midMonth = new Date(Date.UTC(2026, m, 15));
      if (midMonth >= start && midMonth <= end) months.add(m);
    }
    assert.equal(months.size, 12, 'the yearly window must include every month');
  });

  test('it does not bleed into the neighbouring years', () => {
    const { start, end } = periodWindow(2026, 0);
    assert.ok(new Date(Date.UTC(2025, 11, 31)) < start, 'December 2025 leaked in');
    assert.ok(new Date(Date.UTC(2027, 0, 1)) > end, 'January 2027 leaked in');
  });
});

describe('periodWindow — monthly', () => {
  test('August 2026 starts on the 1st and ends on the 31st', () => {
    const w = periodWindow(2026, 8);
    assert.equal(w.isYearly, false);
    assert.equal(iso(w.start), '2026-08-01T00:00:00.000Z');
    assert.equal(iso(w.end), '2026-08-31T23:59:59.000Z');
  });

  test('30-day months end on the 30th', () => {
    assert.equal(iso(periodWindow(2026, 4).end), '2026-04-30T23:59:59.000Z');
    assert.equal(iso(periodWindow(2026, 11).end), '2026-11-30T23:59:59.000Z');
  });

  test('February ends on the 28th in a common year', () => {
    assert.equal(iso(periodWindow(2026, 2).end), '2026-02-28T23:59:59.000Z');
  });

  test('February ends on the 29th in a leap year', () => {
    assert.equal(iso(periodWindow(2028, 2).end), '2028-02-29T23:59:59.000Z');
  });

  test('December stays inside its own year', () => {
    const w = periodWindow(2026, 12);
    assert.equal(iso(w.start), '2026-12-01T00:00:00.000Z');
    assert.equal(iso(w.end), '2026-12-31T23:59:59.000Z');
  });

  test('the last day of the month is inside the window', () => {
    const { end } = periodWindow(2026, 2);
    assert.ok(new Date(Date.UTC(2026, 1, 28, 12, 0, 0)) <= end, 'the 28th was excluded');
  });

  test('consecutive months tile without gap or overlap', () => {
    for (let m = 1; m < 12; m++) {
      const a = periodWindow(2026, m);
      const b = periodWindow(2026, m + 1);
      assert.ok(a.end < b.start, `month ${m} overlaps ${m + 1}`);
      assert.ok(b.start.getTime() - a.end.getTime() <= 1000, `gap between ${m} and ${m + 1}`);
    }
  });
});

/**
 * Billing periods live as separate year/month columns, so "on or before
 * August 2026" is not a comparison either column can make alone.
 */
describe('periodKey / isOnOrBeforePeriod', () => {
  const upTo = (y: number, m: number) => (cy: number, cm: number) => isOnOrBeforePeriod(cy, cm, y, m);

  test('an earlier month in the same year is included', () => {
    assert.equal(upTo(2026, 8)(2026, 3), true);
  });

  test('the boundary month itself is included', () => {
    assert.equal(upTo(2026, 8)(2026, 8), true);
  });

  test('a later month in the same year is excluded', () => {
    assert.equal(upTo(2026, 8)(2026, 9), false);
  });

  test('December of the PREVIOUS year is included despite 12 > 8', () => {
    assert.equal(upTo(2026, 8)(2025, 12), true, 'the classic year/month comparison bug');
  });

  test('January of the NEXT year is excluded despite 1 < 8', () => {
    assert.equal(upTo(2026, 8)(2027, 1), false, 'the same bug in the other direction');
  });

  test('every month of a prior year is included', () => {
    for (let m = 1; m <= 12; m++) assert.equal(upTo(2026, 6)(2025, m), true, `${m}/2025`);
  });

  test('no month of a later year is included', () => {
    for (let m = 1; m <= 12; m++) assert.equal(upTo(2026, 6)(2027, m), false, `${m}/2027`);
  });

  test('a whole-year bound (month 12) takes every month of that year', () => {
    for (let m = 1; m <= 12; m++) assert.equal(upTo(2026, 12)(2026, m), true, `${m}/2026`);
    assert.equal(upTo(2026, 12)(2027, 1), false);
  });

  test('keys are strictly ordered across a year boundary', () => {
    assert.ok(periodKey(2025, 12) < periodKey(2026, 1));
    assert.equal(periodKey(2026, 1) - periodKey(2025, 12), 1, 'consecutive months differ by exactly 1');
  });
});

describe('pktDayBounds', () => {
  test('a PKT day starts at 19:00 UTC the previous day', () => {
    const { start } = pktDayBounds('2026-08-12');
    assert.equal(start.toISOString(), '2026-08-11T19:00:00.000Z');
  });

  test('and ends one millisecond before the next one begins', () => {
    const { end } = pktDayBounds('2026-08-12');
    assert.equal(end.toISOString(), '2026-08-12T18:59:59.999Z');
    assert.equal(end.getTime() + 1, pktDayBounds('2026-08-13').start.getTime());
  });

  test('covers an event logged just after PKT midnight', () => {
    // Stored 2026-08-11T19:57Z, shown to the user as 12:57 AM on 12 Aug.
    // Filtering to UTC midnight excluded it from its own day; 17 real records
    // were invisible under "Today" because of exactly this.
    const evening = new Date('2026-08-11T19:57:13.000Z');
    const { start, end } = pktDayBounds('2026-08-12');
    assert.ok(evening >= start && evening <= end, 'a 12:57 AM PKT event belongs to that PKT day');
    assert.ok(evening < new Date('2026-08-12'), 'and would be missed by a UTC-midnight bound');
  });

  test('excludes an event from the PKT day before', () => {
    const justBefore = new Date('2026-08-11T18:59:59.999Z'); // 11:59:59 PM PKT on the 11th
    assert.ok(justBefore < pktDayBounds('2026-08-12').start);
    assert.ok(justBefore <= pktDayBounds('2026-08-11').end);
  });

  test('every day is exactly 24 hours long', () => {
    for (const d of ['2026-01-01', '2026-02-28', '2026-06-15', '2026-12-31']) {
      const { start, end } = pktDayBounds(d);
      assert.equal(end.getTime() - start.getTime(), 24 * 3600_000 - 1, `${d} must span a full day`);
    }
  });
});
