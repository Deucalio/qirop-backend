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

/**
 * Attribute cash applied to a challan across its fee heads.
 *
 * Line items are priced BEFORE the discount, while the payable is after it and
 * includes the late fee. Scaling the gross items by `applied / payable` — what
 * the collections report used to do — credits every discount to the fee heads
 * as if it had been collected, so the heads summed to more than the cash. Here
 * each item is first reduced by its pro-rata share of the discount, the late
 * fee is its own head, and the shares are then scaled to the cash applied.
 *
 * Rounding is settled on the largest share, so the result always sums to
 * exactly `applied` (to the paisa) and the report's heads reconcile with its
 * total.
 */
export function splitAppliedByHead<T extends string>(
  items: { type: T; amount: Money | number | string }[],
  discountInput: Money | number | string,
  lateFeeInput: Money | number | string,
  appliedInput: Money | number | string,
): { head: T | 'LATE_FEE'; amount: Money }[] {
  const { base, discount, lateFee, amount: payable } = computePayable(
    items.map((i) => i.amount),
    discountInput,
    lateFeeInput,
  );
  const applied = round2(money(appliedInput));
  if (payable.lessThanOrEqualTo(0) || applied.lessThanOrEqualTo(0)) return [];

  const netFactor = base.greaterThan(0) ? base.minus(discount).dividedBy(base) : ZERO;
  const parts: { head: T | 'LATE_FEE'; value: Money }[] = items.map((i) => ({
    head: i.type,
    value: money(i.amount).times(netFactor),
  }));
  if (lateFee.greaterThan(0)) parts.push({ head: 'LATE_FEE', value: lateFee });

  const ratio = applied.dividedBy(payable);
  const shares = parts.map((p) => ({ head: p.head, amount: round2(p.value.times(ratio)) }));

  const residual = applied.minus(sum(shares.map((s) => s.amount)));
  if (!residual.isZero() && shares.length > 0) {
    const largest = shares.reduce((a, b) => (b.amount.greaterThan(a.amount) ? b : a));
    largest.amount = largest.amount.plus(residual);
  }
  return shares.filter((s) => !s.amount.isZero());
}

/**
 * The part of a challan's discount that a payment against it accounts for.
 *
 * Discounts live on the challan, not the payment. A challan settled in two
 * instalments would show its whole discount twice if each receipt carried it,
 * so each receipt takes the share matching the cash it applied — the shares
 * across all receipts then add up to the discount exactly once, and for every
 * receipt `discount share + cash applied` is the fee value it settled.
 */
export function discountShareOf(
  itemAmounts: (Money | number | string)[],
  discountInput: Money | number | string,
  lateFeeInput: Money | number | string,
  appliedInput: Money | number | string,
): Money {
  const { discount, amount: payable } = computePayable(itemAmounts, discountInput, lateFeeInput);
  const applied = money(appliedInput);
  if (payable.lessThanOrEqualTo(0) || applied.lessThanOrEqualTo(0) || discount.isZero()) return ZERO;
  // Overpaying a bill doesn't earn more discount than the bill carries.
  const ratio = applied.greaterThan(payable) ? money(1) : applied.dividedBy(payable);
  return round2(discount.times(ratio));
}

/**
 * Split payments touched by a challan purge into those safe to delete and those
 * that must survive.
 *
 * A payment is only safe to delete when EVERY challan it settles is being
 * purged. Mark-as-paid writes one receipt per student spanning all their bills,
 * so a payment frequently straddles the boundary — deleting one of those would
 * reopen a challan that was genuinely paid and destroy the record of real money.
 *
 * @param onPurged   allocations sitting on challans being deleted
 * @param elsewhere  allocations of those same payments on challans that survive
 */
export function partitionPurgedPayments(
  onPurged: { paymentId: string }[],
  elsewhere: { paymentId: string }[],
) {
  const touched = [...new Set(onPurged.map((a) => a.paymentId))];
  const keep = new Set(elsewhere.map((a) => a.paymentId));
  return {
    orphaned: touched.filter((id) => !keep.has(id)),
    /** Kept, but the freed portion becomes unallocated credit. */
    kept: touched.filter((id) => keep.has(id)),
  };
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
