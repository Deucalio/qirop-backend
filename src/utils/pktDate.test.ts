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
import { periodWindow } from './pktDate';

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
