import { ChallanStatus, FeeItemType, PaymentMethod, Prisma, UserStatus, SalaryStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError, Forbidden, NotFound } from '../../utils/apiResponse';
import { pktDay, pktDayString, parsePktDay, isFuturePktDay, pktMonthRange } from '../../utils/pktDate';
import { money, sum, round2, toMoneyString, ZERO, type Money } from '../../utils/money';
import type { Actor } from '../timetable/timetable.service';
// Pure ledger arithmetic lives in its own IO-free module so it can be unit-tested.
import { paidBreakdown, deriveStatus } from './fees.ledger';
import type { GenerateChallansInput, ListChallansQuery, PatchChallanInput, RecordPaymentInput } from './fees.schema';
import { publicUrl } from '../../services/storage';
import { logAudit } from '../audit/audit.service';

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function audit(tx: Tx, userId: string, action: string, entity: string, entityId: string, metadata: any) {
  try {
    const u = await tx.user.findUnique({ where: { id: userId }, select: { fullName: true, role: true } });
    const targetLabel = metadata?.targetLabel || `${entity} #${entityId.slice(0, 8)}`;
    const details = metadata?.details || metadata?.description || `${u?.fullName ?? 'Admin'} recorded ${action.replace(/_/g, ' ').toLowerCase()} on ${targetLabel}`;

    await tx.auditLog.create({
      data: {
        actorId: userId,
        actorName: u?.fullName ?? 'Admin',
        actorRole: u?.role ?? 'ADMIN',
        action,
        module: 'FEES',
        targetType: entity,
        targetId: entityId,
        targetLabel,
        details,
        changes: metadata?.changes ? (metadata.changes as any) : undefined,
      },
    });
  } catch {
    /* best-effort */
  }
}

/** Retry a serializable transaction on serialization failure (concurrent payments). */
async function runSerializable<T>(
  fn: (tx: Tx) => Promise<T>,
  opts?: { timeout?: number; maxWait?: number },
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        // Generous window: allocation makes several round-trips to a remote DB.
        // Bulk operations (e.g. marking a whole class paid) pass a longer one.
        timeout: opts?.timeout ?? 60_000,
        maxWait: opts?.maxWait ?? 20_000,
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      // 40001 = serialization failure, 40P01 = deadlock. Retry a few times.
      if ((code === 'P2034' || code === '40001' || code === '40P01') && attempt < 4) continue;
      throw err;
    }
  }
}

/** Next sequential challan number for a year, e.g. CH-2026-000123 (counter locked in-tx). */
async function nextChallanNo(tx: Tx, year: number): Promise<string> {
  const counter = await tx.challanCounter.upsert({
    where: { year },
    create: { year, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
  });
  return `CH-${year}-${String(counter.lastNumber).padStart(6, '0')}`;
}

type ChallanWithLedger = Prisma.FeeChallanGetPayload<{
  include: { items: true; allocations: { include: { payment: true } } };
}>;

/** Recompute and persist a challan's status from its current ledger. */
export async function recomputeChallan(tx: Tx, challanId: string) {
  const c = await tx.feeChallan.findUnique({
    where: { id: challanId },
    include: { items: true, allocations: { include: { payment: true } } },
  });
  if (!c) return;
  await tx.feeChallan.update({ where: { id: challanId }, data: { status: deriveStatus(c) } });
}

/**
 * Allocate every payment's unallocated amount to the student's challans with a
 * balance, oldest month first. Used for auto-payment AND to apply credit when
 * new challans are generated. Idempotent — safe to run repeatedly.
 */
async function allocateAvailable(tx: Tx, studentId: string) {
  const payments = await tx.feePayment.findMany({
    where: { studentId, isReversed: false },
    include: { allocations: true },
    orderBy: [{ paymentDate: 'asc' }, { createdAt: 'asc' }],
  });
  const spare = new Map<string, Prisma.Decimal>();
  for (const p of payments) {
    spare.set(p.id, round2(money(p.amount).minus(sum(p.allocations.map((a) => a.amountApplied)))));
  }

  const challans = await tx.feeChallan.findMany({
    where: { studentId },
    include: { items: true, allocations: { include: { payment: true } } },
    orderBy: [{ year: 'asc' }, { month: 'asc' }],
  });

  const touched = new Set<string>();
  for (const c of challans) {
    let need = paidBreakdown(c).balance;
    if (need.lessThanOrEqualTo(0)) continue;
    for (const p of payments) {
      if (need.lessThanOrEqualTo(0)) break;
      const avail = spare.get(p.id)!;
      if (avail.lessThanOrEqualTo(0)) continue;
      const apply = round2(Prisma.Decimal.min(avail, need));
      await tx.feePaymentAllocation.upsert({
        where: { paymentId_challanId: { paymentId: p.id, challanId: c.id } },
        create: { paymentId: p.id, challanId: c.id, amountApplied: apply },
        update: { amountApplied: { increment: apply } },
      });
      spare.set(p.id, round2(avail.minus(apply)));
      need = round2(need.minus(apply));
      touched.add(c.id);
    }
  }
  for (const id of touched) await recomputeChallan(tx, id);
}

// ---------------------------------------------------------------------------
// Fee structures & discounts
// ---------------------------------------------------------------------------

export async function listFeeStructures() {
  const classes = await prisma.class.findMany({
    orderBy: { order: 'asc' },
    include: { feeStructure: true, _count: { select: { sections: true } } },
  });
  return classes.map((c) => ({
    classId: c.id,
    className: c.name,
    monthlyFee: toMoneyString(c.feeStructure?.monthlyFee ?? 0),
    admissionFee: toMoneyString(c.feeStructure?.admissionFee ?? 0),
    hasStructure: !!c.feeStructure,
  }));
}

export async function setFeeStructure(actor: Actor, classId: string, monthlyFee: string, admissionFee?: string) {
  const cls = await prisma.class.findUnique({ where: { id: classId }, include: { feeStructure: true } });
  if (!cls) throw NotFound('Class not found');
  const existingStructure = cls.feeStructure;

  const rawName = cls.name.trim();
  const classLabel = rawName.toLowerCase().startsWith('class') ? rawName : `Class ${rawName}`;

  const result = await prisma.$transaction(async (tx) => {
    const s = await tx.feeStructure.upsert({
      where: { classId },
      create: { classId, monthlyFee, admissionFee: admissionFee ?? '0' },
      update: { monthlyFee, ...(admissionFee !== undefined ? { admissionFee } : {}) },
    });

    const prevMonthly = existingStructure ? toMoneyString(existingStructure.monthlyFee) : '0.00';
    const prevAdmission = existingStructure ? toMoneyString(existingStructure.admissionFee) : '0.00';
    const newMonthly = toMoneyString(s.monthlyFee);
    const newAdmission = toMoneyString(s.admissionFee);

    const changes: Record<string, { before: unknown; after: unknown }> = {};
    if (prevMonthly !== newMonthly) changes.monthlyFee = { before: prevMonthly, after: newMonthly };
    if (prevAdmission !== newAdmission) changes.admissionFee = { before: prevAdmission, after: newAdmission };

    const actorUser = await tx.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });
    const actorName = actorUser?.fullName ?? 'Super Admin';

    await audit(tx, actor.userId, 'UPDATE', 'Class', classId, {
      targetLabel: `${classLabel} Fee Structure`,
      details: `${actorName} updated fee structure for ${classLabel} (Monthly: Rs ${newMonthly}, Admission: Rs ${newAdmission})`,
      changes,
    });
    return s;
  });
  return {
    classId,
    monthlyFee: toMoneyString(result.monthlyFee),
    admissionFee: toMoneyString(result.admissionFee),
    note: 'This affects future challans only. Already-generated challans keep their snapshot amounts.',
  };
}

export async function setStudentDiscount(actor: Actor, studentId: string, feeDiscount: string, discountNote?: string | null) {
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) throw NotFound('Student not found');

  const oldDiscount = toMoneyString(student.feeDiscount);
  const newDiscount = toMoneyString(feeDiscount);

  await prisma.$transaction(async (tx) => {
    await tx.student.update({ where: { id: studentId }, data: { feeDiscount, discountNote: discountNote ?? null } });
    const actorUser = await tx.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });

    await audit(tx, actor.userId, 'DISCOUNT', 'Student', studentId, {
      targetLabel: `${student.firstName}${student.lastName ? ` ${student.lastName}` : ''} (Roll ${student.rollNo})`,
      details: `${actorUser?.fullName ?? 'Admin'} set Rs ${newDiscount} monthly fee discount for ${student.firstName}${student.lastName ? ` ${student.lastName}` : ''}`,
      changes: {
        feeDiscount: { before: oldDiscount, after: newDiscount },
        discountNote: { before: student.discountNote ?? '—', after: discountNote ?? '—' },
      },
    });
  });
  return { studentId, feeDiscount: toMoneyString(feeDiscount), discountNote: discountNote ?? null };
}

// ---------------------------------------------------------------------------
// Challan generation
// ---------------------------------------------------------------------------

export async function generateChallans(actor: Actor, input: GenerateChallansInput) {
  const { year, month, dueDate } = input;
  const students = await prisma.student.findMany({
    where: {
      status: UserStatus.ACTIVE,
      ...(input.studentIds ? { id: { in: input.studentIds } } : {}),
      ...(input.sectionId ? { sectionId: input.sectionId } : {}),
      ...(input.classId ? { section: { classId: input.classId } } : {}),
    },
    include: {
      section: { include: { class: { include: { feeStructure: true } } } },
      transportAssignment: { include: { route: true } },
    },
  });

  const due = parsePktDay(dueDate);
  // Normalise the admin's ad-hoc extra charges once for the whole batch.
  const extraFees = (input.extraFees ?? []).filter((e) => money(e.amount).greaterThan(0));
  const extrasTotal = sum(extraFees.map((e) => e.amount));
  const staffPct = input.staffChildDiscountPercent ?? 0;

  const result = await prisma.$transaction(async (tx) => {
    let created = 0;
    let skipped = 0;
    let staffBilled = 0;
    let transportBilled = 0;
    let total = ZERO;

    for (const s of students) {
      const exists = await tx.feeChallan.findUnique({
        where: { studentId_year_month: { studentId: s.id, year, month } },
      });
      if (exists) {
        skipped++;
        continue;
      }

      const structure = s.section.class.feeStructure;
      const monthly = money(structure?.monthlyFee ?? 0);
      const isFirstChallan = (await tx.feeChallan.count({ where: { studentId: s.id } })) === 0;
      const admission = isFirstChallan ? money(structure?.admissionFee ?? 0) : ZERO;
      // Transport: a rider's route fee lands on their challan (billed to the
      // teacher-parent's salary too, if this is a staff child).
      const route = s.transportAssignment?.route;
      const transport = route?.active ? money(route.monthlyFee) : ZERO;

      // Tuition only when a fee structure is actually set (monthly > 0). Classes
      // with no structure produce no tuition — and no challan at all unless some
      // other charge (transport/exam/other) applies.
      const items: { type: FeeItemType; label: string; amount: string }[] = [];
      if (monthly.greaterThan(0)) {
        items.push({ type: FeeItemType.TUITION, label: 'Monthly Tuition', amount: toMoneyString(monthly) });
      }
      if (admission.greaterThan(0)) {
        items.push({ type: FeeItemType.ADMISSION, label: 'Admission Fee', amount: toMoneyString(admission) });
      }
      if (transport.greaterThan(0)) {
        items.push({ type: FeeItemType.TRANSPORT, label: route!.name || 'Transport', amount: toMoneyString(transport) });
      }
      // Ad-hoc extra charges — each becomes its own labelled OTHER line item.
      for (const e of extraFees) {
        items.push({ type: FeeItemType.OTHER, label: e.label.trim(), amount: toMoneyString(money(e.amount)) });
      }

      // Nothing to bill (e.g. a class with no fee structure and no extras) → skip.
      if (items.length === 0) {
        skipped++;
        continue;
      }

      const base = sum(items.map((i) => i.amount));
      // The student's own recurring discount, plus an optional staff-child perk %.
      let discountRaw = money(s.feeDiscount);
      if (s.teacherParentId && staffPct > 0) {
        discountRaw = discountRaw.plus(base.times(staffPct).dividedBy(100));
      }
      const discount = round2(Prisma.Decimal.min(discountRaw, base)); // never exceed base
      const amount = round2(base.minus(discount));

      const challanNo = await nextChallanNo(tx, year);
      const challan = await tx.feeChallan.create({
        data: {
          challanNo,
          studentId: s.id,
          year,
          month,
          baseAmount: toMoneyString(base),
          discount: toMoneyString(discount),
          amount: toMoneyString(amount),
          dueDate: due,
          status: ChallanStatus.UNPAID,
          // Staff child: fees (minus admission) are billed to the teacher-parent's
          // salary. Coverage happens when salaries are generated (Phase 5C).
          billedToTeacherId: s.teacherParentId ?? null,
          items: { create: items },
        },
      });
      if (s.teacherParentId) staffBilled++;
      if (transport.greaterThan(0)) transportBilled++;
      created++;
      total = total.plus(amount);

      // Apply existing credit oldest-first only when the student actually has
      // payments — most fresh challans have none, so we skip the extra work and
      // just set the correct initial status (UNPAID / OVERDUE if past due).
      const hasPayments = await tx.feePayment.count({ where: { studentId: s.id, isReversed: false } });
      if (hasPayments > 0) await allocateAvailable(tx, s.id);
      await recomputeChallan(tx, challan.id);
    }

    const actorUser = await tx.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });
    await audit(tx, actor.userId, 'CREATE', 'FeeChallan', `${year}-${month}`, {
      targetLabel: `Monthly Fee Challans (${year}-${String(month).padStart(2, '0')})`,
      details: `${actorUser?.fullName ?? 'Admin'} generated ${created} fee challans totaling Rs ${toMoneyString(total)} for term ${year}-${String(month).padStart(2, '0')}`,
      changes: {
        challansCreated: { before: 0, after: created },
        totalAmount: { before: '0.00', after: toMoneyString(total) },
      },
    });

    return { created, skipped, staffBilled, transportBilled, totalAmount: toMoneyString(total) };
    // Generous timeout: bulk generation makes many round-trips to a remote DB.
  }, { timeout: 120_000, maxWait: 20_000 });

  return result;
}

// ---------------------------------------------------------------------------
// Payments (the ledger)
// ---------------------------------------------------------------------------

export async function recordPayment(actor: Actor, input: RecordPaymentInput) {
  const student = await prisma.student.findUnique({ where: { id: input.studentId } });
  if (!student) throw NotFound('Student not found');
  const paymentDate = parsePktDay(input.paymentDate);
  if (isFuturePktDay(paymentDate)) throw new AppError('Payment date cannot be in the future', 400, 'FUTURE_DATE');

  const amount = money(input.amount);

  return runSerializable(async (tx) => {
    const payment = await tx.feePayment.create({
      data: {
        studentId: input.studentId,
        amount: toMoneyString(amount),
        paymentDate,
        method: input.method,
        receivedById: actor.userId,
        note: input.note ?? null,
      },
    });

    if (input.allocations && input.allocations.length > 0) {
      let allocated = ZERO;
      for (const a of input.allocations) {
        const c = await tx.feeChallan.findFirst({
          where: { id: a.challanId, studentId: input.studentId },
          include: { items: true, allocations: { include: { payment: true } } },
        });
        if (!c) throw new AppError('A selected challan does not belong to this student', 400, 'INVALID_CHALLAN');
        const balance = paidBreakdown(c).balance;
        const apply = money(a.amountApplied);
        if (apply.greaterThan(balance)) {
          throw new AppError(
            `Allocation of Rs. ${apply} exceeds the balance of challan ${c.challanNo} (Rs. ${balance})`,
            400,
            'ALLOCATION_EXCEEDS_BALANCE',
          );
        }
        allocated = allocated.plus(apply);
        await tx.feePaymentAllocation.create({
          data: { paymentId: payment.id, challanId: c.id, amountApplied: toMoneyString(apply) },
        });
        await recomputeChallan(tx, c.id);
      }
      if (round2(allocated).greaterThan(round2(amount))) {
        throw new AppError('Allocations exceed the payment amount', 400, 'OVER_ALLOCATED');
      }
    } else {
      await allocateAvailable(tx, input.studentId);
    }

    const actorUser = await tx.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });
    await audit(tx, actor.userId, 'PAYMENT', 'FeePayment', payment.id, {
      targetLabel: `${student.firstName}${student.lastName ? ` ${student.lastName}` : ''} (Receipt #${payment.id.slice(0, 8)})`,
      details: `${actorUser?.fullName ?? 'Admin'} recorded Rs ${toMoneyString(amount)} fee payment for ${student.firstName}${student.lastName ? ` ${student.lastName}` : ''} via ${input.method}`,
      changes: {
        amountPaid: { before: '0.00', after: toMoneyString(amount) },
        paymentMethod: { before: null, after: input.method },
      },
    });

    return getStudentLedgerTx(tx, input.studentId, payment.id);
  });
}

export async function reversePayment(actor: Actor, paymentId: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.feePayment.findUnique({ where: { id: paymentId }, include: { allocations: true, student: true } });
    if (!payment) throw NotFound('Payment not found');
    if (payment.isReversed) throw new AppError('This payment is already reversed', 409, 'ALREADY_REVERSED');

    const affectedChallanIds = payment.allocations.map((a) => a.challanId);
    await tx.feePaymentAllocation.deleteMany({ where: { paymentId } });
    await tx.feePayment.update({
      where: { id: paymentId },
      data: { isReversed: true, reversedAt: pktDay(), reversedById: actor.userId, reversalReason: reason },
    });
    for (const id of affectedChallanIds) await recomputeChallan(tx, id);

    const actorUser = await tx.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });
    await audit(tx, actor.userId, 'REVERSE', 'FeePayment', paymentId, {
      targetLabel: `${payment.student.firstName}${payment.student.lastName ? ` ${payment.student.lastName}` : ''} (Receipt #${payment.id.slice(0, 8)})`,
      details: `${actorUser?.fullName ?? 'Admin'} reversed Rs ${payment.amount} payment for ${payment.student.firstName}${payment.student.lastName ? ` ${payment.student.lastName}` : ''} (Reason: ${reason})`,
      changes: {
        isReversed: { before: false, after: true },
        reversalReason: { before: null, after: reason },
      },
    });

    return getStudentLedgerTx(tx, payment.studentId);
  }, { timeout: 60_000, maxWait: 20_000 });
}

// ---------------------------------------------------------------------------
// Reads / shaping
// ---------------------------------------------------------------------------

function shapeChallan(c: ChallanWithLedger) {
  const { cash, staff, settled, balance } = paidBreakdown(c);
  const pastDue = pktDay().getTime() > c.dueDate.getTime();
  return {
    id: c.id,
    challanNo: c.challanNo,
    studentId: c.studentId,
    year: c.year,
    month: c.month,
    issueDate: pktDayString(c.issueDate),
    dueDate: pktDayString(c.dueDate),
    baseAmount: toMoneyString(c.baseAmount),
    discount: toMoneyString(c.discount),
    lateFee: toMoneyString(c.lateFee),
    amount: toMoneyString(c.amount),
    paidAmount: toMoneyString(settled),
    cashPaid: toMoneyString(cash),
    staffCovered: toMoneyString(staff),
    balance: toMoneyString(balance),
    status: c.status,
    isOverdue: pastDue && balance.greaterThan(0),
    billedToTeacherId: c.billedToTeacherId,
    createdAt: c.createdAt ? c.createdAt.toISOString() : undefined,
    items: c.items
      .sort((a, b) => a.type.localeCompare(b.type))
      .map((i) => ({ id: i.id, type: i.type, label: i.label, amount: toMoneyString(i.amount) })),
  };
}

async function studentCreditTx(tx: Tx, studentId: string) {
  const payments = await tx.feePayment.findMany({
    where: { studentId, isReversed: false },
    include: { allocations: true },
  });
  const paid = sum(payments.map((p) => p.amount));
  const allocated = sum(payments.flatMap((p) => p.allocations.map((a) => a.amountApplied)));
  return round2(paid.minus(allocated));
}

async function getStudentLedgerTx(tx: Tx, studentId: string, highlightPaymentId?: string) {
  const challans = await tx.feeChallan.findMany({
    where: { studentId },
    include: { items: true, allocations: { include: { payment: true } } },
    orderBy: [{ year: 'desc' }, { month: 'desc' }],
  });
  const payments = await tx.feePayment.findMany({
    where: { studentId },
    include: { allocations: { include: { challan: { select: { challanNo: true, year: true, month: true } } } } },
    orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }],
  });

  const shaped = challans.map(shapeChallan);
  const arrears = sum(shaped.filter((c) => c.status !== 'PAID').map((c) => c.balance));
  const credit = await studentCreditTx(tx, studentId);

  // If this is a staff child, name the teacher whose salary settles their fees —
  // the guardian sees exactly where the money came from.
  const staffTeacherId = challans.find((c) => c.billedToTeacherId)?.billedToTeacherId ?? null;
  const staffTeacher = staffTeacherId
    ? await tx.teacherProfile.findUnique({ where: { id: staffTeacherId }, select: { user: { select: { fullName: true } } } })
    : null;
  const staffCoveredTotal = sum(challans.map((c) => c.staffCovered));

  return {
    studentId,
    staffTeacherName: staffTeacher?.user.fullName ?? null,
    staffCoveredTotal: toMoneyString(staffCoveredTotal),
    challans: shaped,
    payments: payments.map((p) => ({
      id: p.id,
      amount: toMoneyString(p.amount),
      paymentDate: pktDayString(p.paymentDate),
      method: p.method,
      note: p.note,
      isReversed: p.isReversed,
      reversedAt: p.reversedAt ? pktDayString(p.reversedAt) : null,
      reversalReason: p.reversalReason,
      isHighlight: p.id === highlightPaymentId,
      allocations: p.allocations.map((a) => ({
        challanNo: a.challan.challanNo,
        year: a.challan.year,
        month: a.challan.month,
        amountApplied: toMoneyString(a.amountApplied),
      })),
    })),
    arrears: toMoneyString(arrears),
    credit: toMoneyString(credit),
  };
}

export async function getStudentLedger(studentId: string) {
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) throw NotFound('Student not found');
  return prisma.$transaction((tx) => getStudentLedgerTx(tx, studentId), { timeout: 30_000, maxWait: 15_000 });
}

/** Parent view — same ledger, but only for the caller's own child. */
export async function getChildFeesForParent(userId: string, studentId: string) {
  const parent = await prisma.parentProfile.findUnique({ where: { userId } });
  if (!parent) throw NotFound('Parent profile not found');
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) throw NotFound('Student not found');
  if (student.parentId !== parent.id) throw Forbidden('This student is not your child');
  return prisma.$transaction((tx) => getStudentLedgerTx(tx, studentId), { timeout: 30_000, maxWait: 15_000 });
}

// ---------------------------------------------------------------------------
// Guardian views (parent + staff parent) — read-only, own children only
// ---------------------------------------------------------------------------

/** Resolve the caller's TeacherProfile, or 404. */
async function teacherProfileOr404(userId: string) {
  const t = await prisma.teacherProfile.findUnique({ where: { userId } });
  if (!t) throw NotFound('Teacher profile not found');
  return t;
}

/**
 * The students billed to this teacher's salary (decision D4). A teacher sees
 * their own children's fees and attendance here — never any salary figure.
 */
export async function getStaffChildrenForTeacher(userId: string) {
  const teacher = await teacherProfileOr404(userId);
  const kids = await prisma.student.findMany({
    where: { teacherParentId: teacher.id },
    include: { section: { include: { class: true } } },
    orderBy: [{ firstName: 'asc' }],
  });

  const now = pktDay();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const { start, endExclusive } = pktMonthRange(year, month);

  return Promise.all(
    kids.map(async (s) => {
      const challans = await prisma.feeChallan.findMany({
        where: { studentId: s.id },
        include: { items: true, allocations: { include: { payment: true } } },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
      });
      const shaped = challans.map(shapeChallan);
      const arrears = sum(shaped.filter((c) => c.status !== 'PAID').map((c) => c.balance));
      // The most recent bill (already ordered newest-first) — not strictly this
      // month, so the guardian still sees something before the new month is generated.
      const latestChallan = shaped[0] ?? null;

      const marks = await prisma.studentAttendance.findMany({
        where: { studentId: s.id, date: { gte: start, lt: endExclusive } },
        select: { status: true },
      });
      const present = marks.filter((m) => m.status === 'PRESENT' || m.status === 'LATE').length;

      return {
        id: s.id,
        name: `${s.firstName}${s.lastName ? ` ${s.lastName}` : ''}`,
        admissionNo: s.admissionNo,
        className: s.section.class.name,
        sectionName: s.section.name,
        photoUrl: publicUrl(s.photoUrl),
        arrears: toMoneyString(arrears),
        latestChallan,
        attendance: {
          year,
          month,
          marked: marks.length,
          present,
          rate: marks.length > 0 ? Math.round((present / marks.length) * 1000) / 10 : 0,
        },
      };
    }),
  );
}

/** A staff child's full fee ledger, for the teacher-parent. */
export async function getStaffChildFeesForTeacher(userId: string, studentId: string) {
  const teacher = await teacherProfileOr404(userId);
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) throw NotFound('Student not found');
  if (student.teacherParentId !== teacher.id) throw Forbidden('This student is not your child');
  return prisma.$transaction((tx) => getStudentLedgerTx(tx, studentId), { timeout: 30_000, maxWait: 15_000 });
}

/**
 * Authorize a guardian (parent or staff parent) to read one challan, then hand
 * back its id for PDF rendering. Guardians only ever see their own children's.
 */
export async function assertGuardianChallan(
  userId: string,
  kind: 'parent' | 'teacher',
  studentId: string,
  challanId: string,
): Promise<string> {
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) throw NotFound('Student not found');

  if (kind === 'parent') {
    const parent = await prisma.parentProfile.findUnique({ where: { userId } });
    if (!parent || student.parentId !== parent.id) throw Forbidden('This student is not your child');
  } else {
    const teacher = await teacherProfileOr404(userId);
    if (student.teacherParentId !== teacher.id) throw Forbidden('This student is not your child');
  }

  const challan = await prisma.feeChallan.findUnique({ where: { id: challanId }, select: { studentId: true } });
  if (!challan || challan.studentId !== studentId) throw NotFound('Challan not found');
  return challanId;
}

export async function listChallans(query: ListChallansQuery) {
  // Query params arrive as strings — coerce the numeric filters.
  const year = query.year != null ? Number(query.year) : undefined;
  const month = query.month != null ? Number(query.month) : undefined;
  const challans = await prisma.feeChallan.findMany({
    where: {
      ...(year ? { year } : {}),
      ...(month ? { month } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.sectionId ? { student: { sectionId: query.sectionId } } : {}),
      ...(query.classId ? { student: { section: { classId: query.classId } } } : {}),
      ...(query.search
        ? {
            student: {
              OR: [
                { firstName: { contains: query.search, mode: 'insensitive' } },
                { lastName: { contains: query.search, mode: 'insensitive' } },
                { admissionNo: { contains: query.search, mode: 'insensitive' } },
              ],
            },
            challanNo: undefined,
          }
        : {}),
    },
    include: {
      items: true,
      allocations: { include: { payment: true } },
      student: {
        include: {
          section: { include: { class: true } },
          parent: { include: { user: true } },
          teacherParent: { include: { user: true } },
        },
      },
    },
    orderBy: [{ year: 'desc' }, { month: 'desc' }, { challanNo: 'asc' }],
    take: 1000,
  });

  // Per-challan "previous dues" = the student's unpaid balance from months BEFORE
  // this challan. Fetch every challan of the listed students once and index them.
  const studentIds = [...new Set(challans.map((c) => c.studentId))];
  const prior = studentIds.length
    ? await prisma.feeChallan.findMany({
        where: { studentId: { in: studentIds } },
        select: {
          studentId: true,
          year: true,
          month: true,
          amount: true,
          staffCovered: true,
          allocations: { where: { payment: { isReversed: false } }, select: { amountApplied: true } },
        },
      })
    : [];
  const byStudent = new Map<string, { year: number; month: number; balance: Money }[]>();
  for (const p of prior) {
    const cash = p.allocations.reduce((s, a) => s.plus(a.amountApplied), ZERO);
    const balance = round2(money(p.amount).minus(p.staffCovered).minus(cash));
    const list = byStudent.get(p.studentId) ?? [];
    list.push({ year: p.year, month: p.month, balance });
    byStudent.set(p.studentId, list);
  }
  const previousBalanceFor = (studentId: string, year: number, month: number) =>
    sum(
      (byStudent.get(studentId) ?? [])
        .filter((x) => (x.year < year || (x.year === year && x.month < month)) && x.balance.greaterThan(0))
        .map((x) => x.balance),
    );

  return challans.map((c) => ({
    ...shapeChallan(c),
    previousBalance: toMoneyString(previousBalanceFor(c.studentId, c.year, c.month)),
    student: {
      id: c.student.id,
      name: `${c.student.firstName}${c.student.lastName ? ` ${c.student.lastName}` : ''}`,
      admissionNo: c.student.admissionNo,
      /**
       * A student can be deactivated after their challan was raised, or the
       * challan may simply be old. The debt stays real either way, so the row
       * says who is no longer with the school rather than hiding it.
       */
      status: c.student.status,
      rollNo: c.student.rollNo,
      className: c.student.section.class.name,
      sectionName: c.student.section.name,
      parentName: c.student.parent?.user?.fullName || 'Parent',
      parentPhone: c.student.parent?.user?.phone || null,
      guardianName: c.student.teacherParent?.user?.fullName || c.student.parent?.user?.fullName || 'Parent',
      guardianPhone: c.student.teacherParent?.user?.phone || c.student.parent?.user?.phone || null,
      guardianRole: c.student.teacherParentId ? 'TEACHER' : 'PARENT',
    },
  }));
}

/**
 * Preview what a `generateChallans` run would do — per class: how many students,
 * how many already billed this month, how many will get a new challan, whether
 * the class even has a fee structure, plus staff-child and transport-rider
 * counts and a rough billed estimate. Powers the Generate Challans modal.
 */
export async function generatePreview(query: {
  year: number;
  month: number;
  classId?: string;
  sectionId?: string;
  studentId?: string;
}) {
  const { year, month } = query;
  const scope = {
    status: UserStatus.ACTIVE,
    ...(query.sectionId ? { sectionId: query.sectionId } : {}),
    ...(query.classId ? { section: { classId: query.classId } } : {}),
    ...(query.studentId ? { id: query.studentId } : {}),
  };

  const students = await prisma.student.findMany({
    where: scope,
    select: {
      id: true,
      teacherParentId: true,
      feeDiscount: true,
      section: { select: { classId: true, class: { select: { name: true, order: true, feeStructure: true } } } },
      transportAssignment: { select: { route: { select: { active: true, monthlyFee: true } } } },
    },
  });

  const challanRows = await prisma.feeChallan.findMany({
    where: { student: scope },
    select: { studentId: true, year: true, month: true },
  });
  const billedThisMonth = new Set(challanRows.filter((c) => c.year === year && c.month === month).map((c) => c.studentId));
  const everBilled = new Set(challanRows.map((c) => c.studentId));

  type Row = {
    classId: string;
    className: string;
    order: number;
    monthlyFee: string;
    admissionFee: string;
    hasStructure: boolean;
    totalStudents: number;
    alreadyBilled: number;
    eligible: number;
    firstTimers: number;
    staffChildren: number;
    transportRiders: number;
    estimatedTotal: string;
  };
  const byClass = new Map<string, Row & { _est: Money }>();

  for (const s of students) {
    const cid = s.section.classId;
    const cls = s.section.class;
    const monthly = money(cls.feeStructure?.monthlyFee ?? 0);
    const admission = money(cls.feeStructure?.admissionFee ?? 0);
    let row = byClass.get(cid);
    if (!row) {
      row = {
        classId: cid,
        className: cls.name,
        order: cls.order,
        monthlyFee: toMoneyString(monthly),
        admissionFee: toMoneyString(admission),
        hasStructure: monthly.greaterThan(0),
        totalStudents: 0,
        alreadyBilled: 0,
        eligible: 0,
        firstTimers: 0,
        staffChildren: 0,
        transportRiders: 0,
        estimatedTotal: '0.00',
        _est: ZERO,
      };
      byClass.set(cid, row);
    }
    row.totalStudents++;
    const alreadyBilled = billedThisMonth.has(s.id);
    if (alreadyBilled) row.alreadyBilled++;

    const route = s.transportAssignment?.route;
    const transport = route?.active ? money(route.monthlyFee) : ZERO;
    if (transport.greaterThan(0)) row.transportRiders++;
    if (s.teacherParentId) row.staffChildren++;

    if (!alreadyBilled) {
      const isFirst = !everBilled.has(s.id);
      // A student generates a challan only if something can be charged.
      const willBill = monthly.greaterThan(0) || transport.greaterThan(0) || (isFirst && admission.greaterThan(0));
      if (willBill) {
        row.eligible++;
        if (isFirst && admission.greaterThan(0)) row.firstTimers++;
        row._est = row._est.plus(monthly).plus(transport).plus(isFirst ? admission : ZERO);
      }
    }
  }

  const rows = [...byClass.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ _est, ...r }) => ({ ...r, estimatedTotal: toMoneyString(_est) }));

  /*
   * Credit that generation will silently spend.
   *
   * `allocateAvailable` settles a new challan from any payment money not yet
   * applied to a bill. That is correct for a genuine advance, but the preview
   * used to say only "advance is applied" without saying how much or to whom —
   * so a run could come back with challans already marked PAID and no
   * indication why. Quantifying it here lets the dialog warn BEFORE the click.
   */
  const eligibleIds = new Set<string>();
  for (const s of students) {
    if (billedThisMonth.has(s.id)) continue;
    const cls = s.section.class;
    const monthly = money(cls.feeStructure?.monthlyFee ?? 0);
    const route = s.transportAssignment?.route;
    const transport = route?.active ? money(route.monthlyFee) : ZERO;
    const admission = money(cls.feeStructure?.admissionFee ?? 0);
    const isFirst = !everBilled.has(s.id);
    if (monthly.greaterThan(0) || transport.greaterThan(0) || (isFirst && admission.greaterThan(0))) {
      eligibleIds.add(s.id);
    }
  }

  const creditPayments = eligibleIds.size
    ? await prisma.feePayment.findMany({
        where: { studentId: { in: [...eligibleIds] }, isReversed: false },
        select: {
          studentId: true,
          amount: true,
          allocations: { select: { amountApplied: true } },
          student: { select: { firstName: true, lastName: true, admissionNo: true } },
        },
      })
    : [];

  const creditByStudent = new Map<string, { amount: Money; name: string; admissionNo: string }>();
  for (const p of creditPayments) {
    const spare = round2(money(p.amount).minus(sum(p.allocations.map((a) => a.amountApplied))));
    if (spare.lessThanOrEqualTo(0)) continue;
    const cur = creditByStudent.get(p.studentId);
    creditByStudent.set(p.studentId, {
      amount: (cur?.amount ?? ZERO).plus(spare),
      name: `${p.student.firstName}${p.student.lastName ? ` ${p.student.lastName}` : ''}`,
      admissionNo: p.student.admissionNo,
    });
  }

  const creditStudents = [...creditByStudent.entries()]
    .map(([studentId, v]) => ({
      studentId,
      name: v.name,
      admissionNo: v.admissionNo,
      credit: toMoneyString(round2(v.amount)),
    }))
    .sort((a, b) => Number(b.credit) - Number(a.credit));

  const creditTotal = round2(sum([...creditByStudent.values()].map((v) => v.amount)));

  return {
    year,
    month,
    classes: rows,
    /**
     * Unallocated payment money held by students this run would bill. It will
     * be applied automatically, so some challans may be created already PAID.
     */
    existingCredit: {
      studentCount: creditStudents.length,
      total: toMoneyString(creditTotal),
      students: creditStudents.slice(0, 50),
    },
    totals: {
      classes: rows.length,
      totalStudents: rows.reduce((n, r) => n + r.totalStudents, 0),
      alreadyBilled: rows.reduce((n, r) => n + r.alreadyBilled, 0),
      willGenerate: rows.reduce((n, r) => n + r.eligible, 0),
      staffChildren: rows.reduce((n, r) => n + r.staffChildren, 0),
      transportRiders: rows.reduce((n, r) => n + r.transportRiders, 0),
      classesWithoutStructure: rows.filter((r) => !r.hasStructure).length,
      estimatedTotal: toMoneyString(sum(rows.map((r) => r.estimatedTotal))),
    },
  };
}

export async function getChallan(id: string) {
  const c = await prisma.feeChallan.findUnique({
    where: { id },
    include: {
      items: true,
      allocations: { include: { payment: true } },
      student: { include: { section: { include: { class: true } }, parent: { include: { user: true } } } },
    },
  });
  if (!c) throw NotFound('Challan not found');

  const shaped = shapeChallan(c);

  // All the student's OTHER challans, so we can both show "previous dues"
  // (unpaid months BEFORE this one) and detect newer unpaid months AFTER it.
  // Live, not snapshotted, and display-only — the debt still lives on each
  // challan, so nothing is double-counted.
  const others = await prisma.feeChallan.findMany({
    where: { studentId: c.studentId, id: { not: c.id } },
    include: { items: true, allocations: { include: { payment: true } } },
    orderBy: [{ year: 'asc' }, { month: 'asc' }],
  });
  const isBefore = (o: { year: number; month: number }) =>
    o.year < c.year || (o.year === c.year && o.month < c.month);

  const previousDues = others
    .map((o) => ({ challan: o, bal: paidBreakdown(o).balance }))
    .filter((x) => isBefore(x.challan) && x.bal.greaterThan(0))
    .map((x) => ({
      id: x.challan.id,
      challanNo: x.challan.challanNo,
      year: x.challan.year,
      month: x.challan.month,
      balance: toMoneyString(x.bal),
      // A staff-billed challan's leftover is a salary shortfall, not the parent
      // ignoring a bill — the UI labels it so.
      staffBilled: !!x.challan.billedToTeacherId,
    }));
  const laterUnpaid = sum(
    others.filter((o) => !isBefore(o)).map((o) => Prisma.Decimal.max(0, paidBreakdown(o).balance)),
  );

  const previousBalance = sum(previousDues.map((p) => p.balance));
  const advanceCredit = await studentCredit(c.studentId);
  const thisBalance = money(shaped.balance);
  // Total owed up to and including this month (what this slip is for).
  const totalPayable = round2(Prisma.Decimal.max(0, previousBalance.plus(thisBalance).minus(advanceCredit)));
  // The student's ENTIRE current net balance across every month — this is the
  // figure the guardian dashboards show, so screen == latest slip.
  const studentTotalDue = round2(Prisma.Decimal.max(0, previousBalance.plus(thisBalance).plus(laterUnpaid).minus(advanceCredit)));

  return {
    ...shaped,
    student: {
      id: c.student.id,
      name: `${c.student.firstName}${c.student.lastName ? ` ${c.student.lastName}` : ''}`,
      admissionNo: c.student.admissionNo,
      /**
       * A student can be deactivated after their challan was raised, or the
       * challan may simply be old. The debt stays real either way, so the row
       * says who is no longer with the school rather than hiding it.
       */
      status: c.student.status,
      rollNo: c.student.rollNo,
      className: c.student.section.class.name,
      sectionName: c.student.section.name,
      parentName: c.student.parent.user.fullName,
      parentPhone: c.student.parent.user.phone,
    },
    previousDues,
    previousBalance: toMoneyString(previousBalance),
    advanceCredit: toMoneyString(advanceCredit),
    totalPayable: toMoneyString(totalPayable),
    // Newer unpaid months exist → this slip is not the current full picture.
    hasLaterDues: laterUnpaid.greaterThan(0),
    studentTotalDue: toMoneyString(studentTotalDue),
  };
}

/** Advance credit outside a transaction (paid − allocated, non-reversed). */
async function studentCredit(studentId: string): Promise<Money> {
  const payments = await prisma.feePayment.findMany({
    where: { studentId, isReversed: false },
    include: { allocations: true },
  });
  const paid = sum(payments.map((p) => p.amount));
  const allocated = sum(payments.flatMap((p) => p.allocations.map((a) => a.amountApplied)));
  return round2(paid.minus(allocated));
}

export async function patchChallan(actor: Actor, id: string, input: PatchChallanInput) {
  return prisma.$transaction(async (tx) => {
    const c = await tx.feeChallan.findUnique({
      where: { id },
      include: { items: true, allocations: { include: { payment: true } } },
    });
    if (!c) throw NotFound('Challan not found');

    // A settled challan is a closed record: reverse a payment before changing it.
    if (c.status === ChallanStatus.PAID) {
      throw new AppError(
        'This challan is fully paid and can no longer be edited. Reverse its payment first if you need to change it.',
        409,
        'CHALLAN_PAID',
      );
    }

    if (input.addItem) {
      await tx.feeChallanItem.create({
        data: { challanId: id, type: input.addItem.type, label: input.addItem.label, amount: input.addItem.amount },
      });
    }
    if (input.removeItemId) {
      await tx.feeChallanItem.deleteMany({ where: { id: input.removeItemId, challanId: id } });
    }

    const items = await tx.feeChallanItem.findMany({ where: { challanId: id } });
    const base = sum(items.map((i) => i.amount));
    const discount =
      input.discount !== undefined ? round2(Prisma.Decimal.min(money(input.discount), base)) : money(c.discount);
    const lateFee = input.lateFee !== undefined ? money(input.lateFee) : money(c.lateFee);
    const amount = round2(base.minus(discount).plus(lateFee));

    // A challan can never be reduced below what has already been paid/covered.
    const settled = paidBreakdown(c).settled;
    if (amount.lessThan(settled)) {
      throw new AppError(
        `The new total (Rs. ${amount}) is less than what is already paid (Rs. ${settled}).`,
        409,
        'AMOUNT_BELOW_PAID',
      );
    }

    await tx.feeChallan.update({
      where: { id },
      data: {
        baseAmount: toMoneyString(base),
        discount: toMoneyString(discount),
        lateFee: toMoneyString(lateFee),
        amount: toMoneyString(amount),
        ...(input.dueDate ? { dueDate: parsePktDay(input.dueDate) } : {}),
      },
    });
    // A larger balance may free credit to apply; a smaller one never over-pays.
    await allocateAvailable(tx, c.studentId);
    await recomputeChallan(tx, id);
    await audit(tx, actor.userId, 'CHALLAN_EDITED', 'FeeChallan', id, {
      discount: toMoneyString(discount), lateFee: toMoneyString(lateFee), amount: toMoneyString(amount),
    });
    return getChallanTx(tx, id);
  }, { timeout: 60_000, maxWait: 20_000 });
}

async function getChallanTx(tx: Tx, id: string) {
  const c = await tx.feeChallan.findUnique({
    where: { id },
    include: { items: true, allocations: { include: { payment: true } } },
  });
  return c ? shapeChallan(c) : null;
}

export async function deleteChallan(actor: Actor, id: string) {
  return prisma.$transaction(async (tx) => {
    const c = await tx.feeChallan.findUnique({
      where: { id },
      include: { allocations: true, student: true },
    });
    if (!c) throw NotFound('Challan not found');
    if (c.allocations.length > 0) {
      throw new AppError('This challan has payments against it and cannot be deleted. Reverse the payments first.', 409, 'HAS_PAYMENTS');
    }
    const actorUser = await tx.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });
    const studentName = c.student ? `${c.student.firstName}${c.student.lastName ? ` ${c.student.lastName}` : ''}` : 'Student';

    await tx.feeChallan.delete({ where: { id } });
    await audit(tx, actor.userId, 'CHALLAN_DELETED', 'FeeChallan', id, {
      targetLabel: `${studentName} (Challan #${c.challanNo})`,
      details: `${actorUser?.fullName ?? 'Admin'} deleted fee challan ${c.challanNo} (Rs. ${toMoneyString(c.amount)}) for ${studentName}`,
      changes: {
        challanNo: { before: c.challanNo, after: null },
        amount: { before: toMoneyString(c.amount), after: null },
      },
    });
    return { deleted: true };
  });
}

export async function deleteChallansBatch(actor: Actor, ids: string[]) {
  return prisma.$transaction(
    async (tx) => {
      let deleted = 0;
      let skipped = 0;
      const deletedChallanNos: string[] = [];

      for (const id of ids) {
        const c = await tx.feeChallan.findUnique({
          where: { id },
          include: { allocations: true, student: true },
        });
        if (!c || c.allocations.length > 0) {
          skipped++;
          continue;
        }
        await tx.feeChallan.delete({ where: { id } });
        deleted++;
        deletedChallanNos.push(c.challanNo);
      }

      if (deleted > 0) {
        const actorUser = await tx.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });
        await audit(tx, actor.userId, 'CHALLANS_DELETED_BATCH', 'FeeChallan', `${deleted} challans`, {
          targetLabel: `${deleted} Fee Challan(s)`,
          details: `${actorUser?.fullName ?? 'Admin'} bulk deleted ${deleted} fee challan(s) (${deletedChallanNos.slice(0, 5).join(', ')}${deletedChallanNos.length > 5 ? ` +${deletedChallanNos.length - 5} more` : ''})`,
          changes: {
            deletedCount: { before: 0, after: deleted },
            skippedCount: { before: 0, after: skipped },
          },
        });
      }

      return { deleted, skipped };
    },
    { timeout: 120_000, maxWait: 20_000 },
  );
}

/**
 * Mark challans paid in bulk (or one) — used for "this whole class paid at the
 * counter today". This is NOT a status flip: it records a real `FeePayment` for
 * each challan's outstanding balance and allocates it to that challan, so the
 * ledger, the collection figures and the reversal path all stay honest.
 * Already-settled challans are skipped rather than double-paid.
 */
export async function markChallansPaid(
  actor: Actor,
  input: { challanIds: string[]; paymentDate: string; method: PaymentMethod; note?: string | null },
) {
  const paymentDate = parsePktDay(input.paymentDate);
  if (isFuturePktDay(paymentDate)) throw new AppError('Payment date cannot be in the future', 400, 'FUTURE_DATE');

  return runSerializable(
    async (tx) => {
      let paid = 0;
      let skipped = 0;
      let total = ZERO;

      // Resolve the outstanding balance of each requested challan first.
      const payable: { challan: { id: string; studentId: string }; balance: Money }[] = [];
      for (const id of input.challanIds) {
        const c = await tx.feeChallan.findUnique({
          where: { id },
          include: { items: true, allocations: { include: { payment: true } } },
        });
        if (!c) {
          skipped++;
          continue;
        }
        const { balance } = paidBreakdown(c);
        if (balance.lessThanOrEqualTo(0)) {
          skipped++; // already settled (cash and/or salary)
          continue;
        }
        payable.push({ challan: { id: c.id, studentId: c.studentId }, balance });
      }

      // One receipt per student (a parent paying several months hands over one
      // lump sum), allocated across that student's selected challans.
      const byStudent = new Map<string, typeof payable>();
      for (const p of payable) {
        const list = byStudent.get(p.challan.studentId) ?? [];
        list.push(p);
        byStudent.set(p.challan.studentId, list);
      }

      for (const [studentId, rows] of byStudent) {
        const studentTotal = sum(rows.map((r) => r.balance));
        const payment = await tx.feePayment.create({
          data: {
            studentId,
            amount: toMoneyString(studentTotal),
            paymentDate,
            method: input.method,
            receivedById: actor.userId,
            note: input.note ?? null,
          },
        });
        for (const r of rows) {
          await tx.feePaymentAllocation.create({
            data: { paymentId: payment.id, challanId: r.challan.id, amountApplied: toMoneyString(r.balance) },
          });
          await recomputeChallan(tx, r.challan.id);
          paid++;
        }
        total = total.plus(studentTotal);
      }

      await audit(tx, actor.userId, 'CHALLANS_MARKED_PAID', 'FeeChallan', `${paid} challans`, {
        requested: input.challanIds.length,
        paid,
        skipped,
        receipts: byStudent.size,
        method: input.method,
        total: toMoneyString(total),
      });

      return { paid, skipped, receipts: byStudent.size, totalCollected: toMoneyString(total) };
    },
    { timeout: 120_000, maxWait: 20_000 },
  );
}

export async function markOverdue(actorId?: string) {
  const today = pktDay();
  const res = await prisma.feeChallan.updateMany({
    where: { status: { in: [ChallanStatus.UNPAID] }, dueDate: { lt: today } },
    data: { status: ChallanStatus.OVERDUE },
  });

  // A summary, not one row per challan: this sweeps every overdue bill at once,
  // and a per-challan trail would swamp the History page. Logged only when it
  // actually changed something, so repeated no-op runs stay silent.
  if (res.count > 0) {
    await logAudit(null, {
      actorId: actorId ?? null,
      actorName: actorId ? undefined : 'System',
      action: 'UPDATE',
      module: 'FEES',
      targetType: 'FeeChallan',
      targetLabel: `${res.count} challan${res.count === 1 ? '' : 's'}`,
      details: `Marked ${res.count} unpaid challan${res.count === 1 ? '' : 's'} as overdue (due before ${pktDayString(today)})`,
      changes: { status: { before: 'UNPAID', after: 'OVERDUE' }, _meta: { count: res.count } },
    });
  }
  return { updated: res.count };
}

// ---------------------------------------------------------------------------
// Payment history & dashboard
// ---------------------------------------------------------------------------

/**
 * The payments ledger.
 *
 * Every row carries how much of it is still unapplied, because that is the
 * figure that silently settles future challans — a payment whose challan was
 * later deleted reverts to looking like advance credit, and without surfacing
 * it there is no way to see that money waiting.
 */
/** 1-indexed so `MONTHS[8]` is August, matching the stored `month` column. */
const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

export async function listPayments(query: {
  studentId?: string;
  from?: string;
  to?: string;
  method?: string;
  search?: string;
  state?: 'all' | 'unallocated' | 'allocated' | 'reversed';
  /**
   * Filter by the STUDENT's status, not the payment's. A student can leave the
   * school while their payment history remains relevant — for reconciling what
   * was collected, or spotting money still sitting against someone who is gone.
   */
  studentStatus?: 'all' | 'ACTIVE' | 'INACTIVE';
}) {
  const q = (query.search ?? '').trim();
  const payments = await prisma.feePayment.findMany({
    where: {
      ...(query.studentId ? { studentId: query.studentId } : {}),
      ...(query.studentStatus && query.studentStatus !== 'all'
        ? { student: { status: query.studentStatus as UserStatus } }
        : {}),
      ...(query.method && query.method !== 'all' ? { method: query.method as PaymentMethod } : {}),
      ...(query.from || query.to
        ? { paymentDate: { ...(query.from ? { gte: parsePktDay(query.from) } : {}), ...(query.to ? { lte: parsePktDay(query.to) } : {}) } }
        : {}),
      ...(q
        ? {
            OR: [
              { student: { firstName: { contains: q, mode: 'insensitive' } } },
              { student: { lastName: { contains: q, mode: 'insensitive' } } },
              { student: { admissionNo: { contains: q, mode: 'insensitive' } } },
              { note: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    include: {
      student: {
        select: {
          id: true, firstName: true, lastName: true, admissionNo: true, status: true,
          section: { select: { name: true, class: { select: { name: true } } } },
        },
      },
      allocations: { include: { challan: { select: { challanNo: true, year: true, month: true } } } },
      receivedBy: { select: { fullName: true } },
    },
    orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }],
    take: 1000,
  });

  const shaped = payments.map((p) => {
    const applied = sum(p.allocations.map((a) => a.amountApplied));
    // A reversed payment has had its allocations removed, so its face value is
    // not "spare" money — it is not credit and must not be counted as such.
    const unallocated = p.isReversed ? ZERO : round2(money(p.amount).minus(applied));
    return {
      id: p.id,
      studentId: p.student.id,
      studentName: `${p.student.firstName}${p.student.lastName ? ` ${p.student.lastName}` : ''}`,
      admissionNo: p.student.admissionNo,
      /** The student's own status — an inactive student can still hold records. */
      studentStatus: p.student.status,
      className: p.student.section.class.name,
      sectionName: p.student.section.name,
      amount: toMoneyString(p.amount),
      applied: toMoneyString(applied),
      unallocated: toMoneyString(unallocated),
      paymentDate: pktDayString(p.paymentDate),
      method: p.method,
      note: p.note,
      receivedBy: p.receivedBy.fullName,
      isReversed: p.isReversed,
      reversedAt: p.reversedAt ? pktDayString(p.reversedAt) : null,
      reversalReason: p.reversalReason,
      allocations: p.allocations
        .map((a) => ({
          challanNo: a.challan.challanNo,
          period: `${MONTHS[a.challan.month] ?? a.challan.month} ${a.challan.year}`,
          amountApplied: toMoneyString(a.amountApplied),
        }))
        .sort((a, b) => a.challanNo.localeCompare(b.challanNo)),
    };
  });

  const filtered =
    query.state === 'unallocated' ? shaped.filter((p) => !p.isReversed && Number(p.unallocated) > 0)
    : query.state === 'allocated' ? shaped.filter((p) => !p.isReversed && Number(p.unallocated) === 0)
    : query.state === 'reversed' ? shaped.filter((p) => p.isReversed)
    : shaped;

  const live = shaped.filter((p) => !p.isReversed);
  return {
    payments: filtered,
    summary: {
      count: filtered.length,
      totalReceived: toMoneyString(sum(live.map((p) => p.amount))),
      totalApplied: toMoneyString(sum(live.map((p) => p.applied))),
      /** Money sitting against no bill — this is what future challans will absorb. */
      totalUnallocated: toMoneyString(sum(live.map((p) => p.unallocated))),
      unallocatedCount: live.filter((p) => Number(p.unallocated) > 0).length,
      cashTotal: toMoneyString(sum(live.filter((p) => p.method === 'CASH').map((p) => p.amount))),
      bankTotal: toMoneyString(sum(live.filter((p) => p.method !== 'CASH').map((p) => p.amount))),
      reversedCount: shaped.filter((p) => p.isReversed).length,
      reversedTotal: toMoneyString(sum(shaped.filter((p) => p.isReversed).map((p) => p.amount))),
      /** Money held against students who have left — easy to overlook otherwise. */
      inactiveStudentCount: new Set(
        live.filter((p) => p.studentStatus !== 'ACTIVE').map((p) => p.studentId),
      ).size,
      inactiveStudentTotal: toMoneyString(
        sum(live.filter((p) => p.studentStatus !== 'ACTIVE').map((p) => p.amount)),
      ),
    },
  };
}

/**
 * Delete several payments at once.
 *
 * One audit entry for the batch rather than one per row: clearing test data can
 * mean dozens of payments, and a row each would bury the History page. The
 * entry still names every payment removed, so nothing is lost.
 */
export async function deletePaymentsBatch(actor: Actor, ids: string[], reason: string) {
  const payments = await prisma.feePayment.findMany({
    where: { id: { in: ids } },
    include: {
      student: { select: { firstName: true, lastName: true, admissionNo: true } },
      allocations: { include: { challan: { select: { id: true, challanNo: true } } } },
    },
  });
  if (payments.length === 0) throw NotFound('No matching payments found');

  const affectedChallanIds = [...new Set(payments.flatMap((p) => p.allocations.map((a) => a.challanId)))];
  const total = sum(payments.map((p) => p.amount));

  await runSerializable(async (tx) => {
    await tx.feePaymentAllocation.deleteMany({ where: { paymentId: { in: payments.map((p) => p.id) } } });
    await tx.feePayment.deleteMany({ where: { id: { in: payments.map((p) => p.id) } } });
    // Every challan those receipts were settling reverts to what it truly owes.
    for (const id of affectedChallanIds) await recomputeChallan(tx, id);
  });

  await logAudit(null, {
    actorId: actor.userId,
    action: 'DELETE',
    module: 'FEES',
    targetType: 'FeePayment',
    targetLabel: `${payments.length} payments · Rs ${toMoneyString(total)}`,
    details:
      `Permanently deleted ${payments.length} payment(s) totalling Rs ${toMoneyString(total)}. ` +
      `Reason: ${reason}` +
      (affectedChallanIds.length
        ? `. ${affectedChallanIds.length} challan(s) were recalculated and may now show unpaid.`
        : '. None were applied to a challan.'),
    changes: {
      _meta: {
        reason,
        total: toMoneyString(total),
        payments: payments.map((p) => ({
          student: `${p.student.firstName}${p.student.lastName ? ` ${p.student.lastName}` : ''} (${p.student.admissionNo})`,
          amount: toMoneyString(p.amount),
          date: pktDayString(p.paymentDate),
          method: p.method,
        })),
        challansAffected: [...new Set(payments.flatMap((p) => p.allocations.map((a) => a.challan.challanNo)))],
      },
    },
  });

  return { deleted: payments.length, challansRecalculated: affectedChallanIds.length };
}

/**
 * Permanently remove a payment.
 *
 * Distinct from `reversePayment`, which is the correct tool for a real receipt
 * entered in error: it keeps the row, marks it reversed and preserves the
 * audit trail. Deletion is for rows that should never have existed at all —
 * test data, duplicate imports — and destroys the record, so it is restricted
 * and always audited with the full detail of what was removed.
 */
export async function deletePayment(actor: Actor, paymentId: string, reason: string) {
  const payment = await prisma.feePayment.findUnique({
    where: { id: paymentId },
    include: {
      student: { select: { firstName: true, lastName: true, admissionNo: true } },
      allocations: { include: { challan: { select: { id: true, challanNo: true } } } },
    },
  });
  if (!payment) throw NotFound('Payment not found');

  const affectedChallanIds = payment.allocations.map((a) => a.challanId);
  const studentName = `${payment.student.firstName}${payment.student.lastName ? ` ${payment.student.lastName}` : ''}`;

  await runSerializable(async (tx) => {
    await tx.feePaymentAllocation.deleteMany({ where: { paymentId } });
    await tx.feePayment.delete({ where: { id: paymentId } });
    // Any challan this money was settling reverts to what it truly owes.
    for (const id of affectedChallanIds) await recomputeChallan(tx, id);
  });

  await logAudit(null, {
    actorId: actor.userId,
    action: 'DELETE',
    module: 'FEES',
    targetType: 'FeePayment',
    targetId: paymentId,
    targetLabel: `${studentName} (${payment.student.admissionNo}) — Rs ${toMoneyString(payment.amount)}`,
    details:
      `Permanently deleted a Rs ${toMoneyString(payment.amount)} ${payment.method} payment for ${studentName} ` +
      `dated ${pktDayString(payment.paymentDate)}. Reason: ${reason}` +
      (affectedChallanIds.length
        ? `. ${affectedChallanIds.length} challan(s) were recalculated: ${payment.allocations.map((a) => a.challan.challanNo).join(', ')}`
        : '. It was not applied to any challan.'),
    changes: {
      _meta: {
        amount: toMoneyString(payment.amount),
        method: payment.method,
        paymentDate: pktDayString(payment.paymentDate),
        reason,
        challansAffected: payment.allocations.map((a) => a.challan.challanNo),
      },
    },
  });

  return { deleted: true, challansRecalculated: affectedChallanIds.length };
}

export async function feesSummary(
  year?: number,
  month?: number,
  months?: number,
  startDate?: string,
  endDate?: string,
) {
  let where: Prisma.FeeChallanWhereInput = {};
  let expenseWhere: Prisma.ExpenseWhereInput = {};
  let salaryWhere: Prisma.SalarySlipWhereInput = { status: SalaryStatus.PAID };

  if (startDate && endDate) {
    const sDate = new Date(startDate + 'T00:00:00.000Z');
    const eDate = new Date(endDate + 'T23:59:59.999Z');
    where = { createdAt: { gte: sDate, lte: eDate } };
    expenseWhere = { date: { gte: sDate, lte: eDate } };
    salaryWhere = { ...salaryWhere, createdAt: { gte: sDate, lte: eDate } };
  } else if (months && months > 0) {
    const now = pktDay();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
    where = { createdAt: { gte: start } };
    expenseWhere = { date: { gte: start } };
    salaryWhere = { ...salaryWhere, createdAt: { gte: start } };
  } else if (year && month) {
    where = { year, month };
    const { start, endExclusive } = pktMonthRange(year, month);
    expenseWhere = { date: { gte: start, lt: endExclusive } };
    salaryWhere = { ...salaryWhere, year, month };
  }

  const [challans, expenseAggr, salaryAggr, expenseCategoryGroups] = await Promise.all([
    prisma.feeChallan.findMany({
      where,
      include: { allocations: { include: { payment: true } } },
    }),
    prisma.expense.aggregate({
      where: expenseWhere,
      _sum: { amount: true },
    }),
    prisma.salarySlip.aggregate({
      where: salaryWhere,
      _sum: { netSalary: true },
    }),
    prisma.expense.groupBy({
      by: ['category'],
      where: expenseWhere,
      _sum: { amount: true },
    }),
  ]);

  let billed = ZERO;
  let collected = ZERO;
  let staffCovered = ZERO;
  let outstanding = ZERO;
  let overdue = 0;
  for (const c of challans) {
    const cash = sum(c.allocations.filter((a) => !a.payment.isReversed).map((a) => a.amountApplied));
    billed = billed.plus(c.amount);
    collected = collected.plus(cash);
    staffCovered = staffCovered.plus(c.staffCovered);
    const bal = money(c.amount).minus(cash).minus(c.staffCovered);
    if (bal.greaterThan(0)) {
      outstanding = outstanding.plus(bal);
      // Genuinely overdue only — a challan that still has time to be paid is
      // outstanding, not overdue. (This previously counted every UNPAID and
      // PARTIAL challan, so "N overdue" overstated what needed chasing.)
      if (c.status === ChallanStatus.OVERDUE || (c.dueDate && new Date(c.dueDate) < pktDay())) overdue++;
    }
  }
  const totalSettled = collected.plus(staffCovered);
  const rate = billed.greaterThan(0) ? round2(totalSettled.dividedBy(billed).times(100)) : ZERO;

  const rawExpense = expenseAggr._sum.amount || ZERO;
  const rawSalary = salaryAggr._sum.netSalary || ZERO;
  const totalExpenses = money(rawExpense).plus(rawSalary);
  const netSurplus = totalSettled.minus(totalExpenses);

  const expensesByCategory = expenseCategoryGroups.map((g) => ({
    category: String(g.category),
    amount: Number(g._sum.amount || 0),
  }));

  if (Number(rawSalary) > 0) {
    expensesByCategory.push({
      category: 'SALARIES',
      amount: Number(rawSalary),
    });
  }

  return {
    year: year ?? new Date().getFullYear(),
    month: month ?? new Date().getMonth() + 1,
    billed: toMoneyString(billed),
    collected: toMoneyString(collected),
    staffCovered: toMoneyString(round2(staffCovered)),
    outstanding: toMoneyString(round2(outstanding)),
    totalExpenses: toMoneyString(totalExpenses),
    totalSalaries: toMoneyString(rawSalary),
    totalOperatingExpenses: toMoneyString(rawExpense),
    netSurplus: toMoneyString(netSurplus),
    expensesByCategory,
    overdueCount: overdue,
    collectionRate: Number(rate.toFixed(1)),
  };
}

export async function feesTrend(months?: number, startDate?: string, endDate?: string) {
  const monthBuckets: { year: number; month: number }[] = [];

  if (startDate && endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    let cur = new Date(Date.UTC(start.getFullYear(), start.getMonth(), 1));
    const endMonth = new Date(Date.UTC(end.getFullYear(), end.getMonth(), 1));

    let iter = 0;
    while (cur <= endMonth && iter < 24) {
      iter++;
      monthBuckets.push({ year: cur.getUTCFullYear(), month: cur.getUTCMonth() + 1 });
      cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
  } else {
    const numMonths = Math.min(24, Math.max(1, months || 6));
    const now = pktDay();
    for (let i = numMonths - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      monthBuckets.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
    }
  }

  if (monthBuckets.length === 0) return [];

  const years = Array.from(new Set(monthBuckets.map((b) => b.year)));
  const [challans, expenses, salarySlips] = await Promise.all([
    prisma.feeChallan.findMany({
      where: { year: { in: years } },
      select: {
        year: true,
        month: true,
        amount: true,
        staffCovered: true,
        allocations: {
          select: {
            amountApplied: true,
            payment: { select: { isReversed: true } },
          },
        },
      },
    }),
    prisma.expense.findMany({
      select: { date: true, amount: true },
    }),
    prisma.salarySlip.findMany({
      where: { year: { in: years }, status: SalaryStatus.PAID },
      select: { year: true, month: true, netSalary: true },
    }),
  ]);

  const map = new Map<string, { collected: Prisma.Decimal; pending: Prisma.Decimal; expenses: Prisma.Decimal }>();
  for (const c of challans) {
    const key = `${c.year}-${c.month}`;
    if (!map.has(key)) map.set(key, { collected: ZERO, pending: ZERO, expenses: ZERO });
    const bucket = map.get(key)!;
    const cash = sum(c.allocations.filter((a) => !a.payment.isReversed).map((a) => a.amountApplied));
    bucket.collected = bucket.collected.plus(cash);
    const pend = Prisma.Decimal.max(0, money(c.amount).minus(cash).minus(c.staffCovered));
    bucket.pending = bucket.pending.plus(pend);
  }

  for (const e of expenses) {
    const key = `${e.date.getUTCFullYear()}-${e.date.getUTCMonth() + 1}`;
    if (!map.has(key)) map.set(key, { collected: ZERO, pending: ZERO, expenses: ZERO });
    const bucket = map.get(key)!;
    bucket.expenses = bucket.expenses.plus(e.amount);
  }

  for (const s of salarySlips) {
    const key = `${s.year}-${s.month}`;
    if (!map.has(key)) map.set(key, { collected: ZERO, pending: ZERO, expenses: ZERO });
    const bucket = map.get(key)!;
    bucket.expenses = bucket.expenses.plus(s.netSalary);
  }

  return monthBuckets.map(({ year, month }) => {
    const b = map.get(`${year}-${month}`);
    const collected = b ? b.collected : ZERO;
    const pending = b ? round2(b.pending) : ZERO;
    const exp = b ? round2(b.expenses) : ZERO;
    const netSurplus = round2(money(collected).minus(exp));

    return {
      year,
      month,
      collected: toMoneyString(collected),
      pending: toMoneyString(pending),
      expenses: toMoneyString(exp),
      netSurplus: toMoneyString(netSurplus),
    };
  });
}
