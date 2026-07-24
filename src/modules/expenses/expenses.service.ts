import { Prisma, Role, PayerType, type ExpenseCategory } from '@prisma/client';
import type { Response } from 'express';
import { prisma } from '../../config/prisma';
import { AppError, NotFound } from '../../utils/apiResponse';
import { money, sum, round2, toMoneyString, ZERO } from '../../utils/money';
import { pktDayString, parsePktDay } from '../../utils/pktDate';
import { replaceFile, deleteFile, proxyDownload } from '../../services/storage';
import type { CreateExpenseInput, UpdateExpenseInput, ListExpensesQuery } from './expenses.schema';

export interface Actor {
  userId: string;
  role: Role;
}

type FundingInput = NonNullable<CreateExpenseInput['funding']>;

/** Normalize funding: default to a single SCHOOL_CASH row, and require the rows to sum to `amount`. */
function resolveFunding(amount: string, funding: FundingInput | undefined): FundingInput {
  const rows = funding && funding.length > 0 ? funding : [{ payerType: PayerType.SCHOOL_CASH, amount }];
  const total = sum(rows.map((r) => r.amount));
  if (!total.equals(money(amount))) {
    throw new AppError(
      `Funding sources add up to Rs ${total} but the expense is Rs ${money(amount)}. They must match.`,
      400,
      'FUNDING_MISMATCH',
    );
  }
  return rows;
}

import { logAudit } from '../audit/audit.service';

async function audit(userId: string, action: string, entityId: string, metadata: Record<string, unknown>) {
  try {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { fullName: true, role: true } });
    await logAudit(null, {
      actorId: userId,
      actorName: u?.fullName ?? 'Admin',
      actorRole: u?.role ?? 'ADMIN',
      action,
      module: 'EXPENSES',
      targetType: 'Expense',
      targetId: entityId,
      targetLabel: (metadata.title as string) || `Expense Voucher #${entityId.slice(0, 6)}`,
      details: (metadata.details as string) || `Expense voucher action ${action}`,
      changes: metadata.changes ? (metadata.changes as any) : undefined,
    });
  } catch {
    /* best-effort */
  }
}

const expenseInclude = {
  recordedBy: { select: { fullName: true } },
  funding: { include: { payer: { select: { fullName: true } } } },
} satisfies Prisma.ExpenseInclude;

function shape(e: Prisma.ExpenseGetPayload<{ include: typeof expenseInclude }>) {
  return {
    id: e.id,
    category: e.category,
    title: e.title,
    amount: toMoneyString(e.amount),
    date: pktDayString(e.date),
    note: e.note,
    hasReceipt: !!e.attachmentUrl,
    receiptUrl: e.attachmentUrl ? `/expenses/${e.id}/receipt` : null,
    recordedBy: e.recordedBy.fullName,
    funding: e.funding.map((f) => ({
      id: f.id,
      payerType: f.payerType,
      payerId: f.payerId,
      payerName: f.payer?.fullName ?? null,
      amount: toMoneyString(f.amount),
      remarks: f.remarks,
    })),
  };
}

export async function listExpenses(query: ListExpensesQuery) {
  const where: Prisma.ExpenseWhereInput = {
    ...(query.category ? { category: query.category } : {}),
    ...(query.from || query.to
      ? { date: { ...(query.from ? { gte: parsePktDay(query.from) } : {}), ...(query.to ? { lte: parsePktDay(query.to) } : {}) } }
      : {}),
    ...(query.search ? { OR: [{ title: { contains: query.search, mode: 'insensitive' } }, { note: { contains: query.search, mode: 'insensitive' } }] } : {}),
  };
  const expenses = await prisma.expense.findMany({ where, include: expenseInclude, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 1000 });
  const total = sum(expenses.map((e) => e.amount));
  return { expenses: expenses.map(shape), total: toMoneyString(total), count: expenses.length };
}

export async function getExpense(id: string) {
  const e = await prisma.expense.findUnique({ where: { id }, include: expenseInclude });
  if (!e) throw NotFound('Expense not found');
  return shape(e);
}

async function validatePayers(funding: FundingInput) {
  const ids = [...new Set(funding.map((f) => f.payerId).filter((x): x is string => !!x))];
  if (ids.length === 0) return;
  const found = await prisma.user.count({ where: { id: { in: ids } } });
  if (found !== ids.length) throw new AppError('A selected payer does not exist', 400, 'BAD_PAYER');
}

export async function createExpense(actor: Actor, input: CreateExpenseInput) {
  const funding = resolveFunding(input.amount, input.funding);
  await validatePayers(funding);
  const created = await prisma.$transaction(async (tx) => {
    const e = await tx.expense.create({
      data: {
        category: input.category,
        title: input.title,
        amount: input.amount,
        date: parsePktDay(input.date),
        note: input.note ?? null,
        recordedById: actor.userId,
        funding: {
          create: funding.map((f) => ({ payerType: f.payerType, payerId: f.payerId ?? null, amount: f.amount, remarks: f.remarks ?? null })),
        },
      },
      include: expenseInclude,
    });
    return e;
  });
  const u = await prisma.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });
  await audit(actor.userId, 'CREATE', created.id, {
    title: created.title,
    details: `${u?.fullName ?? 'Admin'} recorded expense voucher: ${created.title} (Rs ${toMoneyString(created.amount)})`,
    changes: {
      title: { before: null, after: created.title },
      amount: { before: '0.00', after: toMoneyString(created.amount) },
      category: { before: null, after: created.category },
    },
  });
  return shape(created);
}

export async function updateExpense(actor: Actor, id: string, input: UpdateExpenseInput) {
  const existing = await prisma.expense.findUnique({ where: { id } });
  if (!existing) throw NotFound('Expense not found');
  const newAmount = input.amount ?? toMoneyString(existing.amount);
  const fundingChanging = input.funding !== undefined || input.amount !== undefined;
  const funding = fundingChanging ? resolveFunding(newAmount, input.funding ?? undefined) : undefined;
  if (funding) await validatePayers(funding);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.expense.update({
      where: { id },
      data: {
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
        ...(input.date !== undefined ? { date: parsePktDay(input.date) } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
    });
    if (funding) {
      await tx.expenseFunding.deleteMany({ where: { expenseId: id } });
      await tx.expenseFunding.createMany({
        data: funding.map((f) => ({ expenseId: id, payerType: f.payerType, payerId: f.payerId ?? null, amount: f.amount, remarks: f.remarks ?? null })),
      });
    }
    return tx.expense.findUniqueOrThrow({ where: { id }, include: expenseInclude });
  });

  const u = await prisma.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  if (existing.title !== updated.title) changes.title = { before: existing.title, after: updated.title };
  if (!existing.amount.equals(updated.amount)) changes.amount = { before: toMoneyString(existing.amount), after: toMoneyString(updated.amount) };

  await audit(actor.userId, 'UPDATE', id, {
    title: updated.title,
    details: `${u?.fullName ?? 'Admin'} updated expense voucher: ${updated.title}`,
    changes,
  });
  return shape(updated);
}

export async function deleteExpense(actor: Actor, id: string) {
  const e = await prisma.expense.findUnique({ where: { id } });
  if (!e) throw NotFound('Expense not found');
  await prisma.expense.delete({ where: { id } }); // funding cascades
  if (e.attachmentUrl) await deleteFile(e.attachmentUrl).catch(() => undefined);
  const u = await prisma.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });
  await audit(actor.userId, 'DELETE', id, {
    title: e.title,
    details: `${u?.fullName ?? 'Admin'} deleted expense voucher: ${e.title} (Rs ${toMoneyString(e.amount)})`,
  });
  return { id, deleted: true };
}

export async function setReceipt(actor: Actor, id: string, buffer: Buffer, originalName: string, contentType?: string) {
  const e = await prisma.expense.findUnique({ where: { id } });
  if (!e) throw NotFound('Expense not found');
  const path = await replaceFile(e.attachmentUrl, buffer, originalName, `/expenses/${id}`, contentType);
  await prisma.expense.update({ where: { id }, data: { attachmentUrl: path } });
  await audit(actor.userId, 'EXPENSE_RECEIPT_SET', id, {});
  return getExpense(id);
}

export async function streamReceipt(id: string, res: Response) {
  const e = await prisma.expense.findUnique({ where: { id } });
  if (!e || !e.attachmentUrl) throw NotFound('No receipt on this expense');
  await proxyDownload(e.attachmentUrl, res);
}

/** Category totals for a period (defaults to the given month). */
export async function expensesSummary(from: string, to: string) {
  const expenses = await prisma.expense.findMany({
    where: { date: { gte: parsePktDay(from), lte: parsePktDay(to) } },
    select: { category: true, amount: true },
  });
  const byCategory = new Map<ExpenseCategory, Prisma.Decimal>();
  for (const e of expenses) byCategory.set(e.category, (byCategory.get(e.category) ?? ZERO).plus(e.amount));
  return {
    from,
    to,
    total: toMoneyString(sum(expenses.map((e) => e.amount))),
    count: expenses.length,
    byCategory: [...byCategory.entries()].map(([category, amount]) => ({ category, amount: toMoneyString(amount) })).sort((a, b) => Number(b.amount) - Number(a.amount)),
  };
}

/** Year-long income (fees collected) vs expenses vs salaries, month by month. */
export async function financeSummary(year: number) {
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year, 11, 31, 23, 59, 59));

  const [payments, expenses, salaries] = await Promise.all([
    prisma.feePayment.findMany({ where: { isReversed: false, paymentDate: { gte: start, lte: end } }, select: { amount: true, paymentDate: true } }),
    prisma.expense.findMany({ where: { date: { gte: start, lte: end } }, select: { amount: true, date: true } }),
    prisma.salarySlip.findMany({ where: { year }, select: { netSalary: true, month: true } }),
  ]);

  const rows = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, income: ZERO, expenses: ZERO, salaries: ZERO }));
  for (const p of payments) rows[p.paymentDate.getUTCMonth()].income = rows[p.paymentDate.getUTCMonth()].income.plus(p.amount);
  for (const e of expenses) rows[e.date.getUTCMonth()].expenses = rows[e.date.getUTCMonth()].expenses.plus(e.amount);
  for (const s of salaries) rows[s.month - 1].salaries = rows[s.month - 1].salaries.plus(s.netSalary);

  const months = rows.map((r) => ({
    month: r.month,
    income: toMoneyString(r.income),
    expenses: toMoneyString(r.expenses),
    salaries: toMoneyString(r.salaries),
    net: toMoneyString(round2(r.income.minus(r.expenses).minus(r.salaries))),
  }));
  const totalIncome = sum(months.map((m) => m.income));
  const totalExpenses = sum(months.map((m) => m.expenses));
  const totalSalaries = sum(months.map((m) => m.salaries));
  return {
    year,
    months,
    totals: {
      income: toMoneyString(totalIncome),
      expenses: toMoneyString(totalExpenses),
      salaries: toMoneyString(totalSalaries),
      net: toMoneyString(round2(totalIncome.minus(totalExpenses).minus(totalSalaries))),
    },
  };
}
