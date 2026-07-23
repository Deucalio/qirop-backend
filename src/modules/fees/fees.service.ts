import { ChallanStatus, FeeItemType, PaymentMethod, Prisma, UserStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError, Forbidden, NotFound } from '../../utils/apiResponse';
import { pktDay, pktDayString, parsePktDay, isFuturePktDay, pktMonthRange } from '../../utils/pktDate';
import { money, sum, round2, toMoneyString, ZERO, type Money } from '../../utils/money';
import type { Actor } from '../timetable/timetable.service';
import type { GenerateChallansInput, ListChallansQuery, PatchChallanInput, RecordPaymentInput } from './fees.schema';

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function audit(tx: Tx, userId: string, action: string, entity: string, entityId: string, metadata: object) {
  await tx.auditLog.create({ data: { userId, action, entity, entityId, metadata: metadata as Prisma.InputJsonValue } });
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

/** Cash paid = non-reversed allocations; total settled also includes staff-salary coverage. */
function paidBreakdown(c: ChallanWithLedger) {
  const cash = sum(c.allocations.filter((a) => !a.payment.isReversed).map((a) => a.amountApplied));
  const staff = money(c.staffCovered);
  const settled = cash.plus(staff);
  const balance = round2(money(c.amount).minus(settled));
  return { cash, staff, settled: round2(settled), balance };
}

function deriveStatus(c: ChallanWithLedger): ChallanStatus {
  const { settled, balance } = paidBreakdown(c);
  if (balance.lessThanOrEqualTo(0)) return ChallanStatus.PAID;
  if (settled.greaterThan(0)) return ChallanStatus.PARTIAL;
  const pastDue = pktDay().getTime() > c.dueDate.getTime();
  return pastDue ? ChallanStatus.OVERDUE : ChallanStatus.UNPAID;
}

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
  const cls = await prisma.class.findUnique({ where: { id: classId } });
  if (!cls) throw NotFound('Class not found');
  const result = await prisma.$transaction(async (tx) => {
    const s = await tx.feeStructure.upsert({
      where: { classId },
      create: { classId, monthlyFee, admissionFee: admissionFee ?? '0' },
      update: { monthlyFee, ...(admissionFee !== undefined ? { admissionFee } : {}) },
    });
    await audit(tx, actor.userId, 'FEE_STRUCTURE_SET', 'Class', classId, {
      monthlyFee, admissionFee: s.admissionFee.toString(),
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
  await prisma.$transaction(async (tx) => {
    await tx.student.update({ where: { id: studentId }, data: { feeDiscount, discountNote: discountNote ?? null } });
    await audit(tx, actor.userId, 'STUDENT_DISCOUNT_SET', 'Student', studentId, {
      before: student.feeDiscount.toString(), after: feeDiscount, note: discountNote ?? null,
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
  const examFee = input.examFee ? money(input.examFee) : ZERO;
  const otherFee = input.otherFee ? money(input.otherFee) : ZERO;
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
      if (examFee.greaterThan(0)) {
        items.push({ type: FeeItemType.EXAM, label: input.examLabel?.trim() || 'Exam Fee', amount: toMoneyString(examFee) });
      }
      if (otherFee.greaterThan(0)) {
        items.push({ type: FeeItemType.OTHER, label: input.otherLabel?.trim() || 'Other Fee', amount: toMoneyString(otherFee) });
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

    await audit(tx, actor.userId, 'CHALLANS_GENERATED', 'FeeChallan', `${year}-${month}`, {
      year, month, scope: { classId: input.classId, sectionId: input.sectionId, studentIds: input.studentIds?.length },
      created, skipped, staffBilled, transportBilled, total: toMoneyString(total),
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
      // Explicit allocation — direct money at specific challans. Validate each.
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
      // Leftover stays as credit — do not auto-spend it (respect the operator's intent).
    } else {
      // Auto FIFO: fill the oldest unpaid challans; remainder becomes credit.
      await allocateAvailable(tx, input.studentId);
    }

    await audit(tx, actor.userId, 'PAYMENT_RECORDED', 'FeePayment', payment.id, {
      studentId: input.studentId, amount: toMoneyString(amount), method: input.method,
      mode: input.allocations ? 'explicit' : 'auto',
    });

    return getStudentLedgerTx(tx, input.studentId, payment.id);
  });
}

export async function reversePayment(actor: Actor, paymentId: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.feePayment.findUnique({ where: { id: paymentId }, include: { allocations: true } });
    if (!payment) throw NotFound('Payment not found');
    if (payment.isReversed) throw new AppError('This payment is already reversed', 409, 'ALREADY_REVERSED');

    const affectedChallanIds = payment.allocations.map((a) => a.challanId);
    // Remove the allocations, then flag the payment (retained forever).
    await tx.feePaymentAllocation.deleteMany({ where: { paymentId } });
    await tx.feePayment.update({
      where: { id: paymentId },
      data: { isReversed: true, reversedAt: pktDay(), reversedById: actor.userId, reversalReason: reason },
    });
    for (const id of affectedChallanIds) await recomputeChallan(tx, id);

    await audit(tx, actor.userId, 'PAYMENT_REVERSED', 'FeePayment', paymentId, {
      reason, amount: payment.amount.toString(), affectedChallans: affectedChallanIds.length,
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
        name: `${s.firstName} ${s.lastName}`,
        admissionNo: s.admissionNo,
        className: s.section.class.name,
        sectionName: s.section.name,
        photoUrl: s.photoUrl,
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
      student: { include: { section: { include: { class: true } }, parent: { include: { user: true } } } },
    },
    orderBy: [{ year: 'desc' }, { month: 'desc' }, { challanNo: 'asc' }],
    take: 1000,
  });
  return challans.map((c) => ({
    ...shapeChallan(c),
    student: {
      id: c.student.id,
      name: `${c.student.firstName} ${c.student.lastName}`,
      admissionNo: c.student.admissionNo,
      rollNo: c.student.rollNo,
      className: c.student.section.class.name,
      sectionName: c.student.section.name,
      parentName: c.student.parent.user.fullName,
      parentPhone: c.student.parent.user.phone,
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
}) {
  const { year, month } = query;
  const scope = {
    status: UserStatus.ACTIVE,
    ...(query.sectionId ? { sectionId: query.sectionId } : {}),
    ...(query.classId ? { section: { classId: query.classId } } : {}),
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

  return {
    year,
    month,
    classes: rows,
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
  return {
    ...shapeChallan(c),
    student: {
      id: c.student.id,
      name: `${c.student.firstName} ${c.student.lastName}`,
      admissionNo: c.student.admissionNo,
      rollNo: c.student.rollNo,
      className: c.student.section.class.name,
      sectionName: c.student.section.name,
      parentName: c.student.parent.user.fullName,
      parentPhone: c.student.parent.user.phone,
    },
  };
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
    const c = await tx.feeChallan.findUnique({ where: { id }, include: { allocations: true } });
    if (!c) throw NotFound('Challan not found');
    if (c.allocations.length > 0) {
      throw new AppError('This challan has payments against it and cannot be deleted. Reverse the payments first.', 409, 'HAS_PAYMENTS');
    }
    await tx.feeChallan.delete({ where: { id } });
    await audit(tx, actor.userId, 'CHALLAN_DELETED', 'FeeChallan', id, { challanNo: c.challanNo });
    return { deleted: true };
  });
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

        const payment = await tx.feePayment.create({
          data: {
            studentId: c.studentId,
            amount: toMoneyString(balance),
            paymentDate,
            method: input.method,
            receivedById: actor.userId,
            note: input.note ?? null,
          },
        });
        await tx.feePaymentAllocation.create({
          data: { paymentId: payment.id, challanId: id, amountApplied: toMoneyString(balance) },
        });
        await recomputeChallan(tx, id);
        paid++;
        total = total.plus(balance);
      }

      await audit(tx, actor.userId, 'CHALLANS_MARKED_PAID', 'FeeChallan', `${paid} challans`, {
        requested: input.challanIds.length,
        paid,
        skipped,
        method: input.method,
        total: toMoneyString(total),
      });

      return { paid, skipped, totalCollected: toMoneyString(total) };
    },
    { timeout: 120_000, maxWait: 20_000 },
  );
}

export async function markOverdue() {
  const today = pktDay();
  const res = await prisma.feeChallan.updateMany({
    where: { status: { in: [ChallanStatus.UNPAID] }, dueDate: { lt: today } },
    data: { status: ChallanStatus.OVERDUE },
  });
  return { updated: res.count };
}

// ---------------------------------------------------------------------------
// Payment history & dashboard
// ---------------------------------------------------------------------------

export async function listPayments(query: { studentId?: string; from?: string; to?: string }) {
  const payments = await prisma.feePayment.findMany({
    where: {
      ...(query.studentId ? { studentId: query.studentId } : {}),
      ...(query.from || query.to
        ? { paymentDate: { ...(query.from ? { gte: parsePktDay(query.from) } : {}), ...(query.to ? { lte: parsePktDay(query.to) } : {}) } }
        : {}),
    },
    include: {
      student: { select: { firstName: true, lastName: true, admissionNo: true } },
      allocations: { include: { challan: { select: { challanNo: true, year: true, month: true } } } },
      receivedBy: { select: { fullName: true } },
    },
    orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }],
    take: 500,
  });
  return payments.map((p) => ({
    id: p.id,
    studentName: `${p.student.firstName} ${p.student.lastName}`,
    admissionNo: p.student.admissionNo,
    amount: toMoneyString(p.amount),
    paymentDate: pktDayString(p.paymentDate),
    method: p.method,
    note: p.note,
    receivedBy: p.receivedBy.fullName,
    isReversed: p.isReversed,
    reversedAt: p.reversedAt ? pktDayString(p.reversedAt) : null,
    reversalReason: p.reversalReason,
    allocations: p.allocations.map((a) => ({ challanNo: a.challan.challanNo, amountApplied: toMoneyString(a.amountApplied) })),
  }));
}

export async function feesSummary(year: number, month: number) {
  const challans = await prisma.feeChallan.findMany({
    where: { year, month },
    include: { allocations: { include: { payment: true } } },
  });
  let billed = ZERO;
  let collected = ZERO;
  let outstanding = ZERO;
  let overdue = 0;
  for (const c of challans) {
    const cash = sum(c.allocations.filter((a) => !a.payment.isReversed).map((a) => a.amountApplied));
    billed = billed.plus(c.amount);
    collected = collected.plus(cash);
    const bal = money(c.amount).minus(cash).minus(c.staffCovered);
    if (bal.greaterThan(0)) {
      outstanding = outstanding.plus(bal);
      if (c.status === ChallanStatus.OVERDUE) overdue++;
    }
  }
  const rate = billed.greaterThan(0) ? round2(collected.dividedBy(billed).times(100)) : ZERO;
  return {
    year,
    month,
    billed: toMoneyString(billed),
    collected: toMoneyString(collected),
    outstanding: toMoneyString(round2(outstanding)),
    overdueCount: overdue,
    collectionRate: Number(rate.toFixed(1)),
  };
}

export async function feesTrend(months: number) {
  const now = pktDay();
  const out: { year: number; month: number; collected: string; pending: string }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const challans = await prisma.feeChallan.findMany({
      where: { year, month },
      include: { allocations: { include: { payment: true } } },
    });
    let collected = ZERO;
    let pending = ZERO;
    for (const c of challans) {
      const cash = sum(c.allocations.filter((a) => !a.payment.isReversed).map((a) => a.amountApplied));
      collected = collected.plus(cash);
      pending = pending.plus(Prisma.Decimal.max(0, money(c.amount).minus(cash).minus(c.staffCovered)));
    }
    out.push({ year, month, collected: toMoneyString(collected), pending: toMoneyString(round2(pending)) });
  }
  return out;
}
