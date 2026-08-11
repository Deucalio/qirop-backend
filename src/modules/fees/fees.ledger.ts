/**
 * Pure fee-ledger arithmetic — no database, no environment, no IO.
 *
 * A challan's status is DERIVED from its ledger, never stored as the source of
 * truth, so these two functions decide what every screen, PDF and payment flow
 * believes about money. Keeping them free of IO means they can be unit-tested
 * exactly as the rest of the system calls them.
 */
import { ChallanStatus } from '@prisma/client';
import { money, sum, round2, ZERO, type Money } from '../../utils/money';
import { pktDay } from '../../utils/pktDate';

/**
 * The shape the ledger maths actually needs. Declared structurally (rather than
 * as a Prisma payload) so callers — and tests — can pass anything carrying
 * these fields.
 */
export interface LedgerChallan {
  amount: Money | number | string;
  staffCovered: Money | number | string;
  dueDate: Date;
  allocations: { amountApplied: Money | number | string; payment: { isReversed: boolean } }[];
}

/**
 * Cash paid = non-reversed allocations; total settled also includes
 * staff-salary coverage. Reversed payments contribute nothing — the row is
 * retained for audit but must not count as money received.
 */
export function paidBreakdown(c: LedgerChallan) {
  const cash = sum(c.allocations.filter((a) => !a.payment.isReversed).map((a) => a.amountApplied));
  const staff = money(c.staffCovered);
  const settled = cash.plus(staff);
  const balance = round2(money(c.amount).minus(settled));
  return { cash, staff, settled: round2(settled), balance };
}

/**
 * PAID once nothing is left owing (over-payment still reads PAID, the surplus
 * is held as student credit elsewhere); PARTIAL when some money has landed;
 * otherwise UNPAID, or OVERDUE once the due date has passed.
 */
/**
 * Roll a student's challans into what they actually still owe.
 *
 * Used by the defaulters report, which decides who gets chased for money — so
 * it has to agree with `paidBreakdown` exactly. It previously kept its own copy
 * of the arithmetic that subtracted cash but not salary coverage, and billed
 * staff parents for fees already taken out of their pay.
 *
 * Generic in the challan type so callers get their own rows back in `unpaid`
 * and can read month/year off them without this module knowing about periods.
 */
export function outstandingAcross<T extends LedgerChallan>(challans: T[]) {
  let outstanding = ZERO;
  let staffCovered = ZERO;
  const unpaid: T[] = [];

  for (const c of challans) {
    const { balance, staff } = paidBreakdown(c);
    staffCovered = staffCovered.plus(staff);
    if (balance.greaterThan(0)) {
      outstanding = outstanding.plus(balance);
      unpaid.push(c);
    }
  }

  return {
    outstanding: round2(outstanding),
    staffCovered: round2(staffCovered),
    unpaid,
    unpaidCount: unpaid.length,
  };
}

/**
 * What a challan is payable at, given its line items, discount and late fee.
 *
 * Lives here, pure and tested, because the invariant it enforces is easy to
 * lose: a discount can never exceed what is actually being charged. Callers
 * that edit a challan must pass the discount currently on it when the caller
 * did not supply a new one — clamping only the incoming value let a stale
 * discount survive an item removal and drive the payable negative.
 */
export function computePayable(
  itemAmounts: (Money | number | string)[],
  discountInput: Money | number | string,
  lateFeeInput: Money | number | string,
) {
  const base = sum(itemAmounts);
  const discount = round2(base.lessThan(money(discountInput)) ? base : money(discountInput));
  const lateFee = money(lateFeeInput);
  return { base: round2(base), discount, lateFee, amount: round2(base.minus(discount).plus(lateFee)) };
}

export function deriveStatus(c: LedgerChallan): ChallanStatus {
  const { settled, balance } = paidBreakdown(c);
  if (balance.lessThanOrEqualTo(0)) {
    /*
     * Nothing is owed — but WHY matters. This used to return PAID on balance
     * alone, so discounting a challan to zero made it read "Paid" when not a
     * rupee had arrived. PAID is a claim that the school was paid; a waiver is
     * the opposite, money the school chose to forgo. Reporting, receipts and
     * anyone reading the badge need to be able to tell those apart.
     */
    return settled.greaterThan(0) ? ChallanStatus.PAID : ChallanStatus.WAIVED;
  }
  if (settled.greaterThan(0)) return ChallanStatus.PARTIAL;
  const pastDue = pktDay().getTime() > c.dueDate.getTime();
  return pastDue ? ChallanStatus.OVERDUE : ChallanStatus.UNPAID;
}
