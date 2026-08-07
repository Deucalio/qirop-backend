/**
 * Pure payroll-register aggregation — no database, no environment, no IO.
 *
 * A yearly register has to collapse each employee's twelve slips into one row
 * of annual totals. That grouping is where a "Year 2026" report can quietly
 * become "January 2026", or where one employee's pay can leak into another's
 * total, so it lives here where it can be tested exactly as the service calls
 * it — the same split that `fees.ledger.ts` uses.
 */
import { money, sum, round2, ZERO, type Money } from '../../utils/money';

/** The fields the aggregation needs. Declared structurally so tests can pass plain objects. */
export interface PayrollLine {
  teacherId: string;
  month: number;
  /** 'PAID' counts as disbursed; anything else is outstanding. */
  status: string;
  basicSalary: Money | number | string;
  allowances: Money | number | string;
  deductions: Money | number | string;
  staffFeeDeduction: Money | number | string;
  netSalary: Money | number | string;
}

export interface PayrollTotals {
  basic: Money;
  allowances: Money;
  deductions: Money;
  staffFeeDeduction: Money;
  /** Every slip — the payroll committed for the period, paid or not. */
  net: Money;
  /** Only PAID slips: money that has actually left the school. */
  netPaid: Money;
  /** Generated but not yet disbursed. */
  netPending: Money;
  paidCount: number;
  pendingCount: number;
}

const isPaid = (l: PayrollLine) => l.status === 'PAID';

/**
 * `net` counts every slip; `netPaid` counts only disbursed ones.
 *
 * The distinction is not cosmetic: the summary field was named `totalNetPaid`
 * but held the total of ALL slips, so undisbursed payroll was reported as money
 * that had left the school — and the cash-flow chart consumed that figure.
 */
export function payrollTotals(lines: PayrollLine[]): PayrollTotals {
  const paid = lines.filter(isPaid);
  const pending = lines.filter((l) => !isPaid(l));
  return {
    basic: round2(sum(lines.map((l) => l.basicSalary))),
    allowances: round2(sum(lines.map((l) => l.allowances))),
    deductions: round2(sum(lines.map((l) => l.deductions))),
    staffFeeDeduction: round2(sum(lines.map((l) => l.staffFeeDeduction))),
    net: round2(sum(lines.map((l) => l.netSalary))),
    netPaid: round2(sum(paid.map((l) => l.netSalary))),
    netPending: round2(sum(pending.map((l) => l.netSalary))),
    paidCount: paid.length,
    pendingCount: pending.length,
  };
}

/**
 * One group per row of the register.
 *
 * Yearly → one group per employee, holding every slip they have that year.
 * Monthly → one group per slip, preserving the existing row-per-slip layout.
 *
 * Employee order follows first appearance, so the caller's `ORDER BY name`
 * survives the grouping.
 */
export function groupForRegister<T extends PayrollLine>(lines: T[], yearly: boolean): T[][] {
  if (!yearly) return lines.map((l) => [l]);

  const byTeacher = new Map<string, T[]>();
  for (const l of lines) {
    const group = byTeacher.get(l.teacherId);
    if (group) group.push(l);
    else byTeacher.set(l.teacherId, [l]);
  }
  return [...byTeacher.values()];
}

/** A row is PAID only once every slip behind it is. */
export function groupStatus(group: PayrollLine[]): 'PAID' | 'PENDING' {
  return group.length > 0 && group.every((l) => l.status === 'PAID') ? 'PAID' : 'PENDING';
}

/** Months a grouped row covers, ascending — 1 entry monthly, up to 12 yearly. */
export function groupMonths(group: PayrollLine[]): number[] {
  return group.map((l) => l.month).sort((a, b) => a - b);
}

export const ZERO_TOTALS: PayrollTotals = {
  basic: ZERO,
  allowances: ZERO,
  deductions: ZERO,
  staffFeeDeduction: ZERO,
  net: ZERO,
  netPaid: ZERO,
  netPending: ZERO,
  paidCount: 0,
  pendingCount: 0,
};

/** Exposed so callers can format a single group without re-deriving the maths. */
export function groupTotals(group: PayrollLine[]) {
  const t = payrollTotals(group);
  return {
    ...t,
    status: groupStatus(group),
    months: groupMonths(group),
    monthsCovered: group.length,
  };
}

export { money };
