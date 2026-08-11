/**
 * Unit tests for the fee-ledger arithmetic.
 *
 * These cover the rules that silently cost money when they break: a reversed
 * payment must stop counting, staff-salary coverage must settle a challan, and
 * a status must never claim PAID while a balance remains.
 *
 * Run with: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { paidBreakdown, deriveStatus, outstandingAcross, computePayable, type LedgerChallan } from './fees.ledger';

const DAY = 86_400_000;
const future = () => new Date(Date.now() + 30 * DAY);
const past = () => new Date(Date.now() - 30 * DAY);

/** Build a challan with sensible defaults; override only what a test cares about. */
function challan(over: Partial<LedgerChallan> = {}): LedgerChallan {
  return {
    amount: '5000.00',
    staffCovered: '0.00',
    dueDate: future(),
    allocations: [],
    ...over,
  };
}

/** A non-reversed payment allocation. */
const paid = (amountApplied: string) => ({ amountApplied, payment: { isReversed: false } });
/** A reversed one — retained for audit, but it must not count as money received. */
const reversed = (amountApplied: string) => ({ amountApplied, payment: { isReversed: true } });

describe('paidBreakdown', () => {
  test('a fresh challan owes its full amount', () => {
    const { cash, staff, settled, balance } = paidBreakdown(challan());
    assert.equal(cash.toFixed(2), '0.00');
    assert.equal(staff.toFixed(2), '0.00');
    assert.equal(settled.toFixed(2), '0.00');
    assert.equal(balance.toFixed(2), '5000.00');
  });

  test('sums multiple cash allocations', () => {
    const c = challan({ allocations: [paid('2000.00'), paid('1500.00')] });
    const { cash, balance } = paidBreakdown(c);
    assert.equal(cash.toFixed(2), '3500.00');
    assert.equal(balance.toFixed(2), '1500.00');
  });

  test('IGNORES reversed payments — the money went back', () => {
    const c = challan({ allocations: [paid('2000.00'), reversed('3000.00')] });
    const { cash, balance } = paidBreakdown(c);
    assert.equal(cash.toFixed(2), '2000.00', 'reversed allocation must not count as cash');
    assert.equal(balance.toFixed(2), '3000.00', 'reversing must put the amount back on the balance');
  });

  test('staff-salary coverage settles the challan without any cash', () => {
    const c = challan({ staffCovered: '5000.00' });
    const { cash, staff, settled, balance } = paidBreakdown(c);
    assert.equal(cash.toFixed(2), '0.00');
    assert.equal(staff.toFixed(2), '5000.00');
    assert.equal(settled.toFixed(2), '5000.00');
    assert.equal(balance.toFixed(2), '0.00');
  });

  test('cash and salary coverage combine (staff child paying the shortfall)', () => {
    // Salary absorbed 3,000 of a 5,000 challan; the parent paid the rest in cash.
    const c = challan({ staffCovered: '3000.00', allocations: [paid('2000.00')] });
    const { settled, balance } = paidBreakdown(c);
    assert.equal(settled.toFixed(2), '5000.00');
    assert.equal(balance.toFixed(2), '0.00');
  });

  test('over-payment yields a negative balance (surplus is credit, not a fee)', () => {
    const c = challan({ allocations: [paid('6000.00')] });
    assert.equal(paidBreakdown(c).balance.toFixed(2), '-1000.00');
  });

  test('money maths stays exact — no floating-point drift', () => {
    // 0.1 + 0.2 !== 0.3 in binary floats; Decimal must get this right.
    const c = challan({ amount: '0.30', allocations: [paid('0.10'), paid('0.20')] });
    assert.equal(paidBreakdown(c).balance.toFixed(2), '0.00');

    // Three 1,666.67 instalments against 5,000.01.
    const c2 = challan({
      amount: '5000.01',
      allocations: [paid('1666.67'), paid('1666.67'), paid('1666.67')],
    });
    assert.equal(paidBreakdown(c2).balance.toFixed(2), '0.00');
  });
});

describe('computePayable', () => {
  test('a plain challan: base minus discount plus late fee', () => {
    const r = computePayable(['4000', '1000'], '500', '200');
    assert.equal(String(r.base), '5000');
    assert.equal(String(r.discount), '500');
    assert.equal(String(r.amount), '4700');
  });

  test('a discount larger than the charge is clamped, never negative', () => {
    // The bug: a 5000 challan discounted by 2000, then the 4000 item removed.
    // The stale 2000 discount survived against a 1000 base and produced -1000.
    const r = computePayable(['1000'], '2000', '0');
    assert.equal(String(r.discount), '1000', 'the discount cannot exceed what is charged');
    assert.equal(String(r.amount), '0');
    assert.ok(!r.amount.lessThan(0), 'the school must never owe the student');
  });

  test('removing every item leaves nothing payable rather than a credit', () => {
    const r = computePayable([], '2000', '0');
    assert.equal(String(r.amount), '0');
  });

  test('a late fee still applies on top of a fully discounted challan', () => {
    const r = computePayable(['1000'], '1000', '150');
    assert.equal(String(r.discount), '1000');
    assert.equal(String(r.amount), '150', 'the waiver covers the fee, not the penalty');
  });

  test('an exact-match discount zeroes it without going under', () => {
    const r = computePayable(['1200'], '1200', '0');
    assert.equal(String(r.amount), '0');
  });
});

describe('deriveStatus', () => {
  test('UNPAID when nothing has been received and it is not yet due', () => {
    assert.equal(deriveStatus(challan()), 'UNPAID');
  });

  test('OVERDUE when nothing received and the due date has passed', () => {
    assert.equal(deriveStatus(challan({ dueDate: past() })), 'OVERDUE');
  });

  test('PARTIAL once some cash lands, even after the due date', () => {
    const c = challan({ dueDate: past(), allocations: [paid('1000.00')] });
    assert.equal(deriveStatus(c), 'PARTIAL', 'part-paid must outrank overdue, not hide the payment');
  });

  test('PAID when settled in full', () => {
    assert.equal(deriveStatus(challan({ allocations: [paid('5000.00')] })), 'PAID');
  });

  test('PAID when fully covered by salary alone', () => {
    assert.equal(deriveStatus(challan({ staffCovered: '5000.00' })), 'PAID');
  });

  test('PAID on over-payment (balance below zero still counts as settled)', () => {
    assert.equal(deriveStatus(challan({ allocations: [paid('7000.00')] })), 'PAID');
  });

  test('WAIVED when discounted to zero — nothing owed, but nothing was paid', () => {
    // What a full "one-off discount" leaves behind: the payable amount is nil
    // and not a rupee arrived. Calling that PAID asserts the school was paid.
    const c = challan({ amount: '0.00' });
    assert.equal(deriveStatus(c), 'WAIVED', 'a waiver must never be reported as money received');
  });

  test('WAIVED regardless of the due date — a waived charge cannot fall overdue', () => {
    assert.equal(deriveStatus(challan({ amount: '0.00', dueDate: past() })), 'WAIVED');
  });

  test('PAID, not WAIVED, when a discount is partial and the rest is settled', () => {
    // Discounted 5000 -> 2000, then 2000 collected. Real money arrived.
    const c = challan({ amount: '2000.00', allocations: [paid('2000.00')] });
    assert.equal(deriveStatus(c), 'PAID', 'a partial discount settled in cash is genuinely paid');
  });

  test('PAID, not WAIVED, when salary coverage settles it', () => {
    // staffCovered is real recovery from a teacher-parent's pay, not a waiver.
    assert.equal(deriveStatus(challan({ amount: '5000.00', staffCovered: '5000.00' })), 'PAID');
  });

  test('reversing the only payment reopens a PAID challan', () => {
    const settled = challan({ allocations: [paid('5000.00')] });
    assert.equal(deriveStatus(settled), 'PAID');

    // Same challan after the payment is reversed.
    const reopened = challan({ allocations: [reversed('5000.00')], dueDate: past() });
    assert.equal(deriveStatus(reopened), 'OVERDUE', 'a reversal must reopen the balance');
  });

  test('a one-paisa shortfall is PARTIAL, never PAID', () => {
    const c = challan({ amount: '5000.00', allocations: [paid('4999.99')] });
    assert.equal(deriveStatus(c), 'PARTIAL', 'must not round a shortfall away into PAID');
  });

  test('partial salary coverage leaves the remainder payable', () => {
    // Salary could only absorb 2,000 of 5,000 — the rest stays owed in cash.
    const c = challan({ staffCovered: '2000.00' });
    assert.equal(deriveStatus(c), 'PARTIAL');
    assert.equal(paidBreakdown(c).balance.toFixed(2), '3000.00');
  });
});

/**
 * The defaulters report decides who gets chased for money. It used to keep its
 * own copy of this arithmetic that subtracted cash but not salary coverage,
 * which billed staff parents for fees already taken out of their pay.
 */
describe('outstandingAcross', () => {
  const month = (m: number, over: Partial<LedgerChallan> = {}) =>
    ({ ...challan(over), month: m, year: 2026 });

  test('no challans means nothing owed', () => {
    const r = outstandingAcross([]);
    assert.equal(r.outstanding.toFixed(2), '0.00');
    assert.equal(r.unpaidCount, 0);
  });

  test('sums the balances of several unpaid months', () => {
    const r = outstandingAcross([month(1), month(2), month(3)]);
    assert.equal(r.outstanding.toFixed(2), '15000.00');
    assert.equal(r.unpaidCount, 3);
  });

  test('a fully staff-covered child owes NOTHING — the salary already paid it', () => {
    const r = outstandingAcross([
      month(1, { staffCovered: '5000.00' }),
      month(2, { staffCovered: '5000.00' }),
    ]);
    assert.equal(r.outstanding.toFixed(2), '0.00');
    assert.equal(r.unpaidCount, 0, 'a staff parent must not appear as a defaulter');
    assert.equal(r.staffCovered.toFixed(2), '10000.00');
  });

  test('partial salary coverage leaves only the shortfall owing', () => {
    const r = outstandingAcross([month(1, { staffCovered: '3000.00' })]);
    assert.equal(r.outstanding.toFixed(2), '2000.00');
    assert.equal(r.unpaidCount, 1);
    assert.equal(r.staffCovered.toFixed(2), '3000.00');
  });

  test('cash and salary coverage combine across months', () => {
    const r = outstandingAcross([
      month(1, { staffCovered: '2000.00', allocations: [paid('3000.00')] }), // settled
      month(2, { staffCovered: '1000.00' }),                                 // owes 4000
    ]);
    assert.equal(r.outstanding.toFixed(2), '4000.00');
    assert.equal(r.unpaidCount, 1);
  });

  test('a reversed receipt puts the money back on the bill', () => {
    const r = outstandingAcross([month(1, { allocations: [reversed('5000.00')] })]);
    assert.equal(r.outstanding.toFixed(2), '5000.00');
    assert.equal(r.unpaidCount, 1);
  });

  test('over-payment on one month never cancels out dues from another', () => {
    const r = outstandingAcross([
      month(1, { allocations: [paid('9000.00')] }), // 4000 surplus
      month(2),                                     // owes 5000
    ]);
    assert.equal(r.outstanding.toFixed(2), '5000.00', 'credit is held separately, not netted off');
    assert.equal(r.unpaidCount, 1);
  });

  test('unpaid rows come back so the caller can list the months', () => {
    const r = outstandingAcross([month(3), month(4, { staffCovered: '5000.00' }), month(5)]);
    assert.deepEqual(r.unpaid.map((c) => c.month), [3, 5]);
  });
});
