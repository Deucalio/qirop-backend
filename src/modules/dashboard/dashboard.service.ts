/**
 * The dashboard's money figures.
 *
 * Every number here is defined exactly as a printed report defines it, so the
 * dashboard can always be checked against paper:
 *
 *  - Received = fee receipts + transport receipts dated in the period
 *    (reversed receipts and salary-deducted fares excluded), as the Fee
 *    Collections report counts them.
 *  - Spent    = expenses dated in the period + salary slips of the period's
 *    months marked Paid (net pay), as the Expense Ledger and Payroll Register
 *    count them. Together they are the report's cash-flow bar.
 *  - Owed     = the Fee Defaulters report with no period: every unpaid fee
 *    and transport challan as of today, students only.
 *
 * The old dashboard mixed bases (fees *billed for* a month against expenses
 * *paid during* it), which is how it and the report came to show two
 * different deficits for the same month.
 */
import { PaymentMethod, SalaryStatus, TransportPaymentMethod } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { parsePktDay, pktDay, pktDayString } from '../../utils/pktDate';
import { money, sum, toMoneyString, ZERO, type Money } from '../../utils/money';
import { billingMonths, type BillingMonth } from '../fees/fees.periods';
import { getFeeDefaultersReport } from '../reports/reports.service';

export interface DashboardPeriod {
  months?: number;
  startDate?: string;
  endDate?: string;
}

const ymKey = (year: number, month: number) => `${year}-${month}`;
const keyOfDay = (d: Date) => ymKey(d.getUTCFullYear(), d.getUTCMonth() + 1);

/** The calendar days and billing months a dashboard period covers. */
function resolvePeriod(p: DashboardPeriod) {
  const today = pktDay();
  if (p.startDate && p.endDate) {
    return {
      from: parsePktDay(p.startDate),
      to: parsePktDay(p.endDate),
      months: billingMonths({ startDate: p.startDate, endDate: p.endDate }, today, 24),
    };
  }
  const months = billingMonths({ months: Math.max(1, p.months ?? 1) }, today, 24);
  return { from: new Date(Date.UTC(months[0].year, months[0].month - 1, 1)), to: today, months };
}

export async function dashboardFinance(p: DashboardPeriod, access: { spending: boolean }) {
  const { from, to, months } = resolvePeriod(p);
  const inRange = { gte: from, lte: to };
  const blank = () => ({ received: ZERO, spent: ZERO });
  const byMonth = new Map<string, { received: Money; spent: Money }>(months.map((m) => [ymKey(m.year, m.month), blank()]));
  const addTo = (key: string, field: 'received' | 'spent', amount: Money | string | number) => {
    const b = byMonth.get(key);
    if (b) b[field] = b[field].plus(money(amount));
  };

  // ---- Money received -------------------------------------------------------
  const [feePayments, transportPayments] = await Promise.all([
    prisma.feePayment.findMany({
      where: { paymentDate: inRange, isReversed: false },
      select: { amount: true, method: true, paymentDate: true },
    }),
    prisma.transportPayment.findMany({
      where: { paymentDate: inRange, isReversed: false, method: { not: TransportPaymentMethod.SALARY_DEDUCTION } },
      select: { amount: true, method: true, paymentDate: true },
    }),
  ]);
  let cash = ZERO;
  for (const r of [...feePayments, ...transportPayments]) {
    if (r.method === PaymentMethod.CASH) cash = cash.plus(r.amount);
    addTo(keyOfDay(r.paymentDate), 'received', r.amount);
  }
  const fees = sum(feePayments.map((r) => r.amount));
  const transport = sum(transportPayments.map((r) => r.amount));
  const receivedTotal = fees.plus(transport);

  // ---- Money spent (only for people who may see expenses) -------------------
  let spent: null | {
    total: string;
    expenses: string;
    salaries: string;
    /** Expenses filed under Salaries — likely the same pay as the slips. */
    salariesInExpenses: string;
    /** Salary slips of the period that are generated but not yet paid. */
    salariesPending: string;
  } = null;
  if (access.spending) {
    const [expenses, slips] = await Promise.all([
      prisma.expense.findMany({ where: { date: inRange }, select: { amount: true, date: true, category: true } }),
      prisma.salarySlip.findMany({
        where: { OR: months.map((m: BillingMonth) => ({ year: m.year, month: m.month })) },
        select: { year: true, month: true, netSalary: true, status: true },
      }),
    ]);
    for (const e of expenses) addTo(keyOfDay(e.date), 'spent', e.amount);
    const paid = slips.filter((s) => s.status === SalaryStatus.PAID);
    for (const s of paid) addTo(ymKey(s.year, s.month), 'spent', s.netSalary);
    const expenseTotal = sum(expenses.map((e) => e.amount));
    const salaryTotal = sum(paid.map((s) => s.netSalary));
    spent = {
      total: toMoneyString(expenseTotal.plus(salaryTotal)),
      expenses: toMoneyString(expenseTotal),
      salaries: toMoneyString(salaryTotal),
      salariesInExpenses: toMoneyString(sum(expenses.filter((e) => e.category === 'SALARIES').map((e) => e.amount))),
      salariesPending: toMoneyString(sum(slips.filter((s) => s.status !== SalaryStatus.PAID).map((s) => s.netSalary))),
    };
  }

  // ---- Owed to the school today ---------------------------------------------
  const d = (await getFeeDefaultersReport({})).summary;

  return {
    period: { from: pktDayString(from), to: pktDayString(to), months },
    received: {
      total: toMoneyString(receivedTotal),
      fees: toMoneyString(fees),
      transport: toMoneyString(transport),
      cash: toMoneyString(cash),
      bank: toMoneyString(receivedTotal.minus(cash)),
    },
    spent,
    /** Received − spent; null when spending is hidden from this user. */
    net: spent ? toMoneyString(receivedTotal.minus(money(spent.total))) : null,
    byMonth: months.map((m) => {
      const b = byMonth.get(ymKey(m.year, m.month)) ?? blank();
      return { year: m.year, month: m.month, received: toMoneyString(b.received), spent: spent ? toMoneyString(b.spent) : null };
    }),
    dues: {
      asOf: pktDayString(),
      total: d.totalOutstandingAmount,
      fees: d.tuitionOutstanding ?? '0.00',
      transport: d.transportOutstanding ?? '0.00',
      students: d.totalDefaulters,
      families: d.familyCount,
      /** Students who have left but still owe. */
      leavers: d.inactiveCount,
      leaversOwe: d.inactiveOutstanding,
    },
  };
}
