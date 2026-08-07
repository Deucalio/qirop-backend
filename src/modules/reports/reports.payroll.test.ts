/**
 * Unit tests for payroll-register aggregation.
 *
 * The bug these guard against: a yearly register used to be built by asking for
 * month `?? 1`, so "Payroll Register (Year 2026)" silently contained January
 * and nothing else. The invariant that matters is that a yearly total equals
 * the sum of its twelve monthly totals — and that grouping never mixes one
 * employee's pay into another's row.
 *
 * Run with: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  payrollTotals,
  groupForRegister,
  groupStatus,
  groupMonths,
  groupTotals,
  type PayrollLine,
} from './reports.payroll';

/** A slip with sensible defaults; override only what a test cares about. */
function slip(over: Partial<PayrollLine> = {}): PayrollLine {
  return {
    teacherId: 'T1',
    month: 1,
    status: 'PAID',
    basicSalary: '30000.00',
    allowances: '2000.00',
    deductions: '1000.00',
    staffFeeDeduction: '0.00',
    netSalary: '31000.00',
    ...over,
  };
}

/** A full year of slips for one employee. */
const yearFor = (teacherId: string, over: Partial<PayrollLine> = {}) =>
  Array.from({ length: 12 }, (_, i) => slip({ teacherId, month: i + 1, ...over }));

describe('payrollTotals', () => {
  test('an empty register totals zero, not NaN', () => {
    const t = payrollTotals([]);
    assert.equal(t.net.toFixed(2), '0.00');
    assert.equal(t.basic.toFixed(2), '0.00');
    assert.equal(t.paidCount, 0);
    assert.equal(t.pendingCount, 0);
  });

  test('counts anything that is not PAID as pending', () => {
    const t = payrollTotals([slip({ status: 'PAID' }), slip({ status: 'PENDING' }), slip({ status: 'DRAFT' })]);
    assert.equal(t.paidCount, 1);
    assert.equal(t.pendingCount, 2);
  });

  test('money stays exact across twelve months — no floating-point drift', () => {
    const t = payrollTotals(yearFor('T1', { netSalary: '31333.33' }));
    assert.equal(t.net.toFixed(2), '375999.96'); // 31333.33 x 12
  });
});

describe('groupForRegister', () => {
  test('monthly gives one row per slip, exactly as before', () => {
    const lines = [slip({ month: 3 }), slip({ month: 4 })];
    const groups = groupForRegister(lines, false);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map((g) => g.length), [1, 1]);
  });

  test('yearly collapses one employee twelve slips into a single row', () => {
    const groups = groupForRegister(yearFor('T1'), true);
    assert.equal(groups.length, 1, 'a year must be ONE row per employee, not twelve');
    assert.equal(groups[0].length, 12);
  });

  test('yearly keeps employees separate — no pay leaks between rows', () => {
    const groups = groupForRegister([...yearFor('T1'), ...yearFor('T2')], true);
    assert.equal(groups.length, 2);
    for (const g of groups) {
      assert.equal(new Set(g.map((l) => l.teacherId)).size, 1, 'a row mixed two employees');
      assert.equal(g.length, 12);
    }
  });

  test('employee order follows first appearance, so ORDER BY name survives', () => {
    const lines = [slip({ teacherId: 'Zara' }), slip({ teacherId: 'Ali' }), slip({ teacherId: 'Zara', month: 2 })];
    assert.deepEqual(groupForRegister(lines, true).map((g) => g[0].teacherId), ['Zara', 'Ali']);
  });

  test('an employty register yields no rows', () => {
    assert.deepEqual(groupForRegister([], true), []);
    assert.deepEqual(groupForRegister([], false), []);
  });
});

describe('the yearly total equals the sum of its months', () => {
  // Deliberately uneven: a raise mid-year, a bonus month, one fee deduction.
  const lines: PayrollLine[] = [
    slip({ month: 1, basicSalary: '30000.00', netSalary: '31000.00' }),
    slip({ month: 2, basicSalary: '30000.00', netSalary: '31000.00' }),
    slip({ month: 3, basicSalary: '35000.00', netSalary: '36000.00' }),
    slip({ month: 4, basicSalary: '35000.00', netSalary: '31500.00', staffFeeDeduction: '4500.00' }),
    slip({ month: 5, basicSalary: '35000.00', allowances: '9000.00', netSalary: '43000.00' }),
  ];

  test('summing each month separately matches one yearly pass', () => {
    const monthByMonth = lines
      .map((l) => payrollTotals([l]).net)
      .reduce((a, b) => a.plus(b));
    const yearly = payrollTotals(lines).net;
    assert.equal(yearly.toFixed(2), monthByMonth.toFixed(2));
    assert.equal(yearly.toFixed(2), '172500.00');
  });

  test('a single grouped row carries the same annual net', () => {
    const [group] = groupForRegister(lines, true);
    assert.equal(groupTotals(group).net.toFixed(2), '172500.00');
  });

  test('staff fee deductions aggregate across the year too', () => {
    assert.equal(payrollTotals(lines).staffFeeDeduction.toFixed(2), '4500.00');
  });

  test('a January-only read is NOT the year — the original bug', () => {
    const january = payrollTotals([lines[0]]).net;
    const year = payrollTotals(lines).net;
    assert.notEqual(january.toFixed(2), year.toFixed(2));
    assert.equal(january.toFixed(2), '31000.00');
  });
});

describe('groupStatus', () => {
  test('PAID only when every slip in the year is paid', () => {
    assert.equal(groupStatus(yearFor('T1', { status: 'PAID' })), 'PAID');
  });

  test('one unpaid month makes the whole year PENDING', () => {
    const g = yearFor('T1');
    g[7].status = 'PENDING';
    assert.equal(groupStatus(g), 'PENDING', 'eleven paid months must not read as fully settled');
  });

  test('an empty group is never PAID', () => {
    assert.equal(groupStatus([]), 'PENDING');
  });
});

describe('groupMonths / monthsCovered', () => {
  test('a mid-year joiner is visibly on fewer months', () => {
    const joiner = [7, 8, 9, 10, 11, 12].map((m) => slip({ teacherId: 'New', month: m }));
    const t = groupTotals(joiner);
    assert.equal(t.monthsCovered, 6);
    assert.deepEqual(t.months, [7, 8, 9, 10, 11, 12]);
  });

  test('months come back ascending regardless of row order', () => {
    assert.deepEqual(groupMonths([slip({ month: 11 }), slip({ month: 2 }), slip({ month: 7 })]), [2, 7, 11]);
  });

  test('monthly rows report exactly one month covered', () => {
    const [group] = groupForRegister([slip({ month: 5 })], false);
    assert.equal(groupTotals(group).monthsCovered, 1);
  });
});
