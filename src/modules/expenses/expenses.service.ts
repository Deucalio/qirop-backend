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

import { publicUrl, uploadFile } from '../../services/storage';

const expenseInclude = {
  recordedBy: { select: { fullName: true } },
  funding: { include: { payer: { select: { fullName: true } } } },
  attachments: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.ExpenseInclude;

function shape(e: Prisma.ExpenseGetPayload<{ include: typeof expenseInclude }>) {
  const attachments = (e.attachments && e.attachments.length > 0)
    ? e.attachments.map((att) => ({
        id: att.id,
        fileUrl: publicUrl(att.fileUrl),
        fileName: att.fileName ?? 'Receipt Image',
        fileSize: att.fileSize ?? 0,
        mimeType: att.mimeType ?? null,
        downloadUrl: `/api/expenses/attachments/${att.id}/download`,
      }))
    : e.attachmentUrl
    ? [
        {
          id: 'legacy',
          fileUrl: publicUrl(e.attachmentUrl),
          fileName: 'Receipt',
          fileSize: 0,
          mimeType: null,
          downloadUrl: `/api/expenses/${e.id}/receipt`,
        },
      ]
    : [];

  return {
    id: e.id,
    category: e.category,
    title: e.title,
    amount: toMoneyString(e.amount),
    date: pktDayString(e.date),
    note: e.note,
    hasReceipt: attachments.length > 0,
    receiptUrl: attachments.length > 0 ? attachments[0].downloadUrl : null,
    attachments,
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
  const e = await prisma.expense.findUnique({ where: { id }, include: { attachments: true } });
  if (!e) throw NotFound('Expense not found');
  await prisma.expense.delete({ where: { id } }); // funding and attachments cascade
  if (e.attachmentUrl) await deleteFile(e.attachmentUrl).catch(() => undefined);
  for (const att of e.attachments) {
    await deleteFile(att.fileUrl).catch(() => undefined);
  }
  const u = await prisma.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });
  await audit(actor.userId, 'DELETE', id, {
    title: e.title,
    details: `${u?.fullName ?? 'Admin'} deleted expense voucher: ${e.title} (Rs ${toMoneyString(e.amount)})`,
  });
  return { id, deleted: true };
}

export async function addExpenseAttachment(
  actor: Actor,
  expenseId: string,
  buffer: Buffer,
  originalName: string,
  mimeType?: string,
) {
  const e = await prisma.expense.findUnique({ where: { id: expenseId }, include: { attachments: true } });
  if (!e) throw NotFound('Expense not found');

  if (e.attachments.length >= 10) {
    throw new AppError('An expense cannot have more than 10 receipt attachments', 400, 'ATTACHMENT_LIMIT');
  }

  const filePath = await uploadFile(buffer, originalName, `/expenses/${expenseId}`, mimeType);
  const attachment = await prisma.expenseAttachment.create({
    data: {
      expenseId,
      fileUrl: filePath,
      fileName: originalName,
      fileSize: buffer.length,
      mimeType: mimeType ?? null,
    },
  });

  await audit(actor.userId, 'EXPENSE_ATTACHMENT_ADD', expenseId, { fileName: originalName });
  return getExpense(expenseId);
}

export async function removeExpenseAttachment(actor: Actor, attachmentId: string) {
  const att = await prisma.expenseAttachment.findUnique({ where: { id: attachmentId } });
  if (!att) throw NotFound('Attachment not found');

  await deleteFile(att.fileUrl).catch(() => undefined);
  await prisma.expenseAttachment.delete({ where: { id: attachmentId } });

  await audit(actor.userId, 'EXPENSE_ATTACHMENT_DELETE', att.expenseId, { attachmentId });
  return getExpense(att.expenseId);
}

export async function downloadExpenseAttachment(attachmentId: string, res: Response) {
  const att = await prisma.expenseAttachment.findUnique({ where: { id: attachmentId } });
  if (!att) throw NotFound('Attachment not found');
  await proxyDownload(att.fileUrl, res);
}

export async function setReceipt(actor: Actor, id: string, buffer: Buffer, originalName: string, contentType?: string) {
  return addExpenseAttachment(actor, id, buffer, originalName, contentType);
}

export async function streamReceipt(id: string, res: Response) {
  const e = await prisma.expense.findUnique({ where: { id }, include: { attachments: true } });
  if (!e) throw NotFound('Expense not found');
  if (e.attachments.length > 0) {
    await proxyDownload(e.attachments[0].fileUrl, res);
  } else if (e.attachmentUrl) {
    await proxyDownload(e.attachmentUrl, res);
  } else {
    throw NotFound('No receipt on this expense');
  }
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

/** Year-long income (fees collected) vs expenses vs salaries, month by month, with detailed breakdown. */
export async function financeSummary(year: number) {
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year, 11, 31, 23, 59, 59));

  const [payments, expenses, salaries] = await Promise.all([
    prisma.feePayment.findMany({
      where: { isReversed: false, paymentDate: { gte: start, lte: end } },
      include: {
        allocations: {
          include: {
            challan: {
              include: { items: true },
            },
          },
        },
      },
    }),
    prisma.expense.findMany({
      where: { date: { gte: start, lte: end } },
      select: { amount: true, category: true, date: true },
    }),
    prisma.salarySlip.findMany({
      where: { year },
      select: { netSalary: true, basicSalary: true, staffFeeDeduction: true, month: true, status: true },
    }),
  ]);

  const rows = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    income: ZERO,
    expenses: ZERO,
    salaries: ZERO,
    feesBreakdown: { tuition: ZERO, transport: ZERO, admission: ZERO, lateFee: ZERO },
    expenseCategories: new Map<ExpenseCategory, { amount: Prisma.Decimal; count: number }>(),
    salaryBreakdown: { basicSalary: ZERO, staffFeeDeduction: ZERO, netPaid: ZERO, staffPaidCount: 0, staffPendingCount: 0 },
  }));

  for (const p of payments) {
    const mIdx = p.paymentDate.getUTCMonth();
    rows[mIdx].income = rows[mIdx].income.plus(p.amount);

    for (const alloc of p.allocations) {
      const challan = alloc.challan;
      if (!challan || !challan.amount || Number(challan.amount) <= 0) continue;
      const ratio = money(alloc.amountApplied).dividedBy(money(challan.amount));

      for (const item of challan.items) {
        const itemShare = round2(money(item.amount).times(ratio));
        if (item.type === 'TUITION') rows[mIdx].feesBreakdown.tuition = rows[mIdx].feesBreakdown.tuition.plus(itemShare);
        else if (item.type === 'TRANSPORT') rows[mIdx].feesBreakdown.transport = rows[mIdx].feesBreakdown.transport.plus(itemShare);
        else if (item.type === 'ADMISSION') rows[mIdx].feesBreakdown.admission = rows[mIdx].feesBreakdown.admission.plus(itemShare);
        else rows[mIdx].feesBreakdown.lateFee = rows[mIdx].feesBreakdown.lateFee.plus(itemShare);
      }
    }
  }

  for (const e of expenses) {
    const mIdx = e.date.getUTCMonth();
    rows[mIdx].expenses = rows[mIdx].expenses.plus(e.amount);

    const catMap = rows[mIdx].expenseCategories;
    const cur = catMap.get(e.category) ?? { amount: ZERO, count: 0 };
    cur.amount = cur.amount.plus(e.amount);
    cur.count += 1;
    catMap.set(e.category, cur);
  }

  for (const s of salaries) {
    const mIdx = s.month - 1;
    if (mIdx < 0 || mIdx > 11) continue;
    rows[mIdx].salaries = rows[mIdx].salaries.plus(s.netSalary);
    rows[mIdx].salaryBreakdown.basicSalary = rows[mIdx].salaryBreakdown.basicSalary.plus(s.basicSalary);
    rows[mIdx].salaryBreakdown.staffFeeDeduction = rows[mIdx].salaryBreakdown.staffFeeDeduction.plus(s.staffFeeDeduction);
    if (s.status === 'PAID') {
      rows[mIdx].salaryBreakdown.netPaid = rows[mIdx].salaryBreakdown.netPaid.plus(s.netSalary);
      rows[mIdx].salaryBreakdown.staffPaidCount += 1;
    } else {
      rows[mIdx].salaryBreakdown.staffPendingCount += 1;
    }
  }

  const months = rows.map((r) => ({
    month: r.month,
    income: toMoneyString(r.income),
    expenses: toMoneyString(r.expenses),
    salaries: toMoneyString(r.salaries),
    net: toMoneyString(round2(r.income.minus(r.expenses).minus(r.salaries))),
    feesBreakdown: {
      tuition: toMoneyString(r.feesBreakdown.tuition),
      transport: toMoneyString(r.feesBreakdown.transport),
      admission: toMoneyString(r.feesBreakdown.admission),
      lateFee: toMoneyString(r.feesBreakdown.lateFee),
    },
    expenseCategories: [...r.expenseCategories.entries()].map(([cat, val]) => ({
      category: cat,
      amount: toMoneyString(val.amount),
      count: val.count,
    })).sort((a, b) => Number(b.amount) - Number(a.amount)),
    salaryBreakdown: {
      basicSalary: toMoneyString(r.salaryBreakdown.basicSalary),
      staffFeeDeduction: toMoneyString(r.salaryBreakdown.staffFeeDeduction),
      netPaid: toMoneyString(r.salaryBreakdown.netPaid),
      staffPaidCount: r.salaryBreakdown.staffPaidCount,
      staffPendingCount: r.salaryBreakdown.staffPendingCount,
    },
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
