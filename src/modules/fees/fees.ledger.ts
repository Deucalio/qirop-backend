/**
 * Pure fee-ledger arithmetic — no database, no environment, no IO.
 *
 * A challan's status is DERIVED from its ledger, never stored as the source of
 * truth, so these two functions decide what every screen, PDF and payment flow
 * believes about money. Keeping them free of IO means they can be unit-tested
 * exactly as the rest of the system calls them.
 */
import { ChallanStatus } from '@prisma/client';
import { money, sum, round2, type Money } from '../../utils/money';
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
export function deriveStatus(c: LedgerChallan): ChallanStatus {
  const { settled, balance } = paidBreakdown(c);
  if (balance.lessThanOrEqualTo(0)) return ChallanStatus.PAID;
  if (settled.greaterThan(0)) return ChallanStatus.PARTIAL;
  const pastDue = pktDay().getTime() > c.dueDate.getTime();
  return pastDue ? ChallanStatus.OVERDUE : ChallanStatus.UNPAID;
}
