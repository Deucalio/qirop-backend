import { Prisma, Role, PayerType, TransportPaymentMethod, type ExpenseCategory } from '@prisma/client';
import type { Response } from 'express';
import { prisma } from '../../config/prisma';
import { AppError, NotFound } from '../../utils/apiResponse';
import { money, sum, round2, toMoneyString, ZERO } from '../../utils/money';
import { pktDayString, parsePktDay } from '../../utils/pktDate';
import { voucherNoOf, receiptSuffixFromQuery } from '../../utils/receiptNo';
import { replaceFile, deleteFile, deleteFilesBatch, proxyDownload } from '../../services/storage';
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
import { splitAppliedByHead } from '../fees/fees.ledger';
import { collectionHeadOf } from '../fees/fees.charges';

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

import { publicUrl, uploadFile, uploadFilesBatch } from '../../services/storage';

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
    voucherNo: voucherNoOf(e.id),
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
  /*
   * A voucher number names one expense, so it is found whatever month or
   * category is selected. Falls through to the normal title/note search when
   * nothing matches, so a six-letter word still works.
   */
  const voucherSuffix = receiptSuffixFromQuery(query.search);
  const voucherIds = voucherSuffix
    ? (await prisma.expense.findMany({ where: { id: { endsWith: voucherSuffix } }, select: { id: true } })).map((e) => e.id)
    : [];
  const isVoucherLookup = voucherIds.length > 0;

  const where: Prisma.ExpenseWhereInput = isVoucherLookup ? { id: { in: voucherIds } } : {
    ...(query.category ? { category: query.category } : {}),
    ...(query.from || query.to
      ? { date: { ...(query.from ? { gte: parsePktDay(query.from) } : {}), ...(query.to ? { lte: parsePktDay(query.to) } : {}) } }
      : {}),
    ...(query.search ? { OR: [{ title: { contains: query.search, mode: 'insensitive' } }, { note: { contains: query.search, mode: 'insensitive' } }] } : {}),
  };
  const expenses = await prisma.expense.findMany({ where, include: expenseInclude, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 1000 });
  const total = sum(expenses.map((e) => e.amount));
  return {
    expenses: expenses.map(shape),
    total: toMoneyString(total),
    count: expenses.length,
    /** 'voucher' when the search was a voucher number and the filters were set aside to find it. */
    lookup: isVoucherLookup ? ('voucher' as const) : null,
  };
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
  
  // Clean up all attached files from FileStore API in a single batch call
  const paths = [e.attachmentUrl, ...e.attachments.map((att) => att.fileUrl)].filter(Boolean);
  if (paths.length > 0) {
    await deleteFilesBatch(paths);
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
  return addExpenseAttachmentsBatch(actor, expenseId, [{ buffer, originalName, mimeType }]);
}

export async function addExpenseAttachmentsBatch(
  actor: Actor,
  expenseId: string,
  files: Array<{ buffer: Buffer; originalName: string; mimeType?: string }>,
) {
  if (files.length === 0) return getExpense(expenseId);

  const e = await prisma.expense.findUnique({ where: { id: expenseId }, include: { attachments: true } });
  if (!e) throw NotFound('Expense not found');

  if (e.attachments.length + files.length > 10) {
    throw new AppError(
      `An expense cannot have more than 10 receipt attachments. Existing: ${e.attachments.length}, Adding: ${files.length}`,
      400,
      'ATTACHMENT_LIMIT',
    );
  }

  // Receipts and invoices: the figures on them have to stay readable, so these
  // are documents rather than pictures.
  const paths = await uploadFilesBatch(
    files.map((f) => ({ buffer: f.buffer, originalName: f.originalName, contentType: f.mimeType })),
    `/expenses/${expenseId}`,
    'document',
  );

  await prisma.expenseAttachment.createMany({
    data: files.map((f, i) => ({
      expenseId,
      fileUrl: paths[i],
      fileName: f.originalName,
      fileSize: f.buffer.length,
      mimeType: f.mimeType ?? null,
    })),
  });

  await audit(actor.userId, 'EXPENSE_ATTACHMENT_ADD_BATCH', expenseId, { count: files.length });
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

  const [payments, transportPayments, expenses, salaries] = await Promise.all([
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
    /*
     * Transport fares are billed on their own challans, so their money never
     * passes through a fee payment and has to be counted here in its own right.
     * A SALARY_DEDUCTION record is left out: that fare was never cash in hand,
     * and the salaries below are already counted net of it.
     */
    prisma.transportPayment.findMany({
      where: {
        isReversed: false,
        method: { not: TransportPaymentMethod.SALARY_DEDUCTION },
        paymentDate: { gte: start, lte: end },
      },
      select: { amount: true, paymentDate: true },
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

  /*
   * Money in is split by what it paid for exactly as the Fee Collections
   * report splits it (same head rules, discounts shared out), so a month's
   * parts add up to what was received. The old split applied the payment's
   * ratio to item amounts before discount, so the parts could exceed the
   * money, and opening arrears showed as "other".
   */
  const blankFees = () => ({
    tuition: ZERO, arrears: ZERO, admission: ZERO, other: ZERO, lateFee: ZERO,
    certificate: ZERO, transport: ZERO, notApplied: ZERO,
  });
  const rows = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    income: ZERO,
    expenses: ZERO,
    /** Net pay on slips marked paid — what actually went out, as the Payroll Register counts it. */
    salaries: ZERO,
    salariesPending: ZERO,
    salariesInExpenses: ZERO,
    feesBreakdown: blankFees(),
    expenseCategories: new Map<ExpenseCategory, { amount: Prisma.Decimal; count: number }>(),
    salaryBreakdown: { basicSalary: ZERO, staffFeeDeduction: ZERO, netPaid: ZERO, staffPaidCount: 0, staffPendingCount: 0 },
  }));

  for (const p of payments) {
    const mIdx = p.paymentDate.getUTCMonth();
    const fb = rows[mIdx].feesBreakdown;
    rows[mIdx].income = rows[mIdx].income.plus(p.amount);
    let applied = ZERO;
    for (const alloc of p.allocations) {
      const c = alloc.challan;
      if (!c) continue;
      applied = applied.plus(alloc.amountApplied);
      const items = c.items.map((i) => ({ type: collectionHeadOf(i), amount: i.amount }));
      for (const share of splitAppliedByHead(items, c.discount, c.lateFee, alloc.amountApplied)) {
        if (share.head === 'TUITION') fb.tuition = fb.tuition.plus(share.amount);
        else if (share.head === 'ARREARS') fb.arrears = fb.arrears.plus(share.amount);
        else if (share.head === 'ADMISSION') fb.admission = fb.admission.plus(share.amount);
        else if (share.head === 'CERTIFICATE') fb.certificate = fb.certificate.plus(share.amount);
        else if (share.head === 'TRANSPORT') fb.transport = fb.transport.plus(share.amount);
        else if (share.head === 'LATE_FEE') fb.lateFee = fb.lateFee.plus(share.amount);
        else fb.other = fb.other.plus(share.amount); // exam fees and hand-typed lines
      }
    }
    const left = money(p.amount).minus(applied);
    if (left.greaterThan(0)) fb.notApplied = fb.notApplied.plus(left);
  }

  for (const t of transportPayments) {
    const mIdx = t.paymentDate.getUTCMonth();
    rows[mIdx].income = rows[mIdx].income.plus(t.amount);
    rows[mIdx].feesBreakdown.transport = rows[mIdx].feesBreakdown.transport.plus(t.amount);
  }

  for (const e of expenses) {
    const mIdx = e.date.getUTCMonth();
    rows[mIdx].expenses = rows[mIdx].expenses.plus(e.amount);

    if (e.category === 'SALARIES') rows[mIdx].salariesInExpenses = rows[mIdx].salariesInExpenses.plus(e.amount);
    const catMap = rows[mIdx].expenseCategories;
    const cur = catMap.get(e.category) ?? { amount: ZERO, count: 0 };
    cur.amount = cur.amount.plus(e.amount);
    cur.count += 1;
    catMap.set(e.category, cur);
  }

  for (const s of salaries) {
    const mIdx = s.month - 1;
    if (mIdx < 0 || mIdx > 11) continue;
    rows[mIdx].salaryBreakdown.basicSalary = rows[mIdx].salaryBreakdown.basicSalary.plus(s.basicSalary);
    rows[mIdx].salaryBreakdown.staffFeeDeduction = rows[mIdx].salaryBreakdown.staffFeeDeduction.plus(s.staffFeeDeduction);
    if (s.status === 'PAID') {
      rows[mIdx].salaries = rows[mIdx].salaries.plus(s.netSalary);
      rows[mIdx].salaryBreakdown.netPaid = rows[mIdx].salaryBreakdown.netPaid.plus(s.netSalary);
      rows[mIdx].salaryBreakdown.staffPaidCount += 1;
    } else {
      rows[mIdx].salariesPending = rows[mIdx].salariesPending.plus(s.netSalary);
      rows[mIdx].salaryBreakdown.staffPendingCount += 1;
    }
  }

  const months = rows.map((r) => ({
    month: r.month,
    income: toMoneyString(r.income),
    expenses: toMoneyString(r.expenses),
    salaries: toMoneyString(r.salaries),
    salariesPending: toMoneyString(r.salariesPending),
    salariesInExpenses: toMoneyString(r.salariesInExpenses),
    net: toMoneyString(round2(r.income.minus(r.expenses).minus(r.salaries))),
    feesBreakdown: Object.fromEntries(Object.entries(r.feesBreakdown).map(([k, v]) => [k, toMoneyString(v)])) as Record<keyof typeof r.feesBreakdown, string>,
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
  const totalPending = sum(months.map((m) => m.salariesPending));
  const totalInExpenses = sum(months.map((m) => m.salariesInExpenses));

  return {
    year,
    months,
    totals: {
      income: toMoneyString(totalIncome),
      expenses: toMoneyString(totalExpenses),
      salaries: toMoneyString(totalSalaries),
      salariesPending: toMoneyString(totalPending),
      salariesInExpenses: toMoneyString(totalInExpenses),
      net: toMoneyString(round2(totalIncome.minus(totalExpenses).minus(totalSalaries))),
    },
  };
}
