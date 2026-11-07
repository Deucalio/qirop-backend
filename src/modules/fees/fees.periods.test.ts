/**
 * Which billing months a dashboard period covers. The dashboard must select
 * the same challans as the Challans page for a month, so it goes by billing
 * month, never by the day a challan was generated.
 *
 * Run with: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { billingMonths } from './fees.periods';

const today = new Date(Date.UTC(2026, 9, 31)); // 31 Oct 2026
const keys = (list: { year: number; month: number }[]) => list.map((m) => `${m.year}-${m.month}`);

describe('billingMonths', () => {
  test('"this month" is the billing month of today', () => {
    assert.deepEqual(keys(billingMonths({ months: 1 }, today)), ['2026-10']);
  });

  test('last N months end with the current month, oldest first', () => {
    assert.deepEqual(keys(billingMonths({ months: 6 }, today)), ['2026-5', '2026-6', '2026-7', '2026-8', '2026-9', '2026-10']);
  });

  test('crosses a year boundary', () => {
    assert.deepEqual(keys(billingMonths({ months: 3 }, new Date(Date.UTC(2027, 0, 5)))), ['2026-11', '2026-12', '2027-1']);
  });

  test('a date range covers every month it touches, inclusive', () => {
    assert.deepEqual(keys(billingMonths({ startDate: '2026-10-01', endDate: '2026-10-31' }, today)), ['2026-10']);
    assert.deepEqual(keys(billingMonths({ startDate: '2026-09-15', endDate: '2026-11-02' }, today)), ['2026-9', '2026-10', '2026-11']);
  });

  test('a range is used in preference to months', () => {
    assert.deepEqual(keys(billingMonths({ months: 6, startDate: '2026-02-01', endDate: '2026-02-28' }, today)), ['2026-2']);
  });

  test('a reversed range is empty rather than running backwards', () => {
    assert.deepEqual(billingMonths({ startDate: '2026-10-01', endDate: '2026-09-01' }, today), []);
  });

  test('limit caps the count', () => {
    assert.equal(billingMonths({ months: 60 }, today, 24).length, 24);
    assert.equal(billingMonths({ startDate: '2020-01-01', endDate: '2026-12-31' }, today, 24).length, 24);
  });

  test('months below one still means the current month', () => {
    assert.deepEqual(keys(billingMonths({ months: 0 }, today)), ['2026-10']);
  });
});
