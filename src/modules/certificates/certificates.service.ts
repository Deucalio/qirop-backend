/**
 * Certificate fees: what the school charges for a document, and the record of
 * having issued one.
 *
 * The money deliberately does NOT live in this module. Charging for a
 * certificate adds a CERTIFICATE line to the student's challan, because that is
 * the single path the ledger, the defaulters list, the collections report and
 * the year's profit-and-loss already read. A parallel store of certificate
 * income would have to be added to each of those by hand, and would drift from
 * the fee ledger the first time one was edited and the other was not.
 *
 * What this module owns is the issuing event: who was given what, when, by
 * whom, and which challan line it produced.
 */
import { CertificateKind, FeeItemType, Prisma, UserStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { NotFound, AppError } from '../../utils/apiResponse';
import { logAudit } from '../audit/audit.service';
import { money, toMoneyString, round2, ZERO } from '../../utils/money';
import { pktDay, pktDayString, parsePktDay } from '../../utils/pktDate';
import type { Prisma as PrismaNs } from '@prisma/client';
import { recomputeChallan } from '../fees/fees.service';
import type { Actor } from '../timetable/timetable.service';

/** Human names for the kinds, used in audit sentences and on the fee list. */
export const CERTIFICATE_LABEL: Record<CertificateKind, string> = {
  STUDENT_ID: 'Student ID Card',
  LEAVING: 'School Leaving Certificate',
  CHARACTER: 'Character Certificate',
  ACHIEVEMENT: 'Certificate of Achievement',
};

const KIND_PREFIX: Record<CertificateKind, string> = {
  STUDENT_ID: 'SID',
  LEAVING: 'SLC',
  CHARACTER: 'CC',
  ACHIEVEMENT: 'CERT',
};

// ---------------------------------------------------------------------------
// The price list
// ---------------------------------------------------------------------------

/** Every kind, priced or not — the UI shows the full list so nothing is hidden. */
export async function listCertificateFees() {
  const rows = await prisma.certificateFee.findMany({
    include: { updatedBy: { select: { fullName: true } } },
  });
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  return Object.values(CertificateKind).map((kind) => {
    const r = byKind.get(kind);
    return {
      kind,
      label: CERTIFICATE_LABEL[kind],
      amount: r ? toMoneyString(r.amount) : '0.00',
      // A kind with no row, or a zero amount, is issued free.
      active: r ? r.active && money(r.amount).greaterThan(0) : false,
      updatedBy: r?.updatedBy?.fullName ?? null,
      updatedAt: r?.updatedAt ?? null,
    };
  });
}

export async function setCertificateFee(actor: Actor, kind: CertificateKind, amount: string, active = true) {
  const value = money(amount);
  if (value.lessThan(0)) throw new AppError('A fee cannot be negative', 400, 'INVALID_AMOUNT');

  const before = await prisma.certificateFee.findUnique({ where: { kind } });
  const row = await prisma.certificateFee.upsert({
    where: { kind },
    create: { kind, amount: toMoneyString(value), active, updatedById: actor.userId },
    update: { amount: toMoneyString(value), active, updatedById: actor.userId },
  });

  await logAudit(null, {
    actorId: actor.userId,
    action: 'UPDATE',
    module: 'CERTIFICATES',
    targetType: 'CertificateFee',
    targetId: row.id,
    targetLabel: `${CERTIFICATE_LABEL[kind]} fee`,
    details:
      `Set the ${CERTIFICATE_LABEL[kind]} fee to Rs ${toMoneyString(value)}` +
      (before ? ` (was Rs ${toMoneyString(before.amount)})` : ' (not previously priced)') +
      (active ? '' : '. Charging is switched off, so it now issues free'),
    changes: {
      amount: { before: before ? toMoneyString(before.amount) : '0.00', after: toMoneyString(value) },
      active: { before: before ? String(before.active) : 'false', after: String(active) },
    },
  });

  return { kind, label: CERTIFICATE_LABEL[kind], amount: toMoneyString(row.amount), active: row.active };
}

// ---------------------------------------------------------------------------
// Issuing
// ---------------------------------------------------------------------------

/** Sequential per kind and year, so a serial reads back as what it is. */
async function nextSerial(tx: Prisma.TransactionClient, kind: CertificateKind, year: number) {
  const prefix = `${KIND_PREFIX[kind]}-${year}-`;
  const last = await tx.certificateIssue.findFirst({
    where: { serial: { startsWith: prefix } },
    orderBy: { serial: 'desc' },
    select: { serial: true },
  });
  const n = last ? Number(last.serial.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(n).padStart(4, '0')}`;
}

export interface RecordIssueInput {
  studentId: string;
  kind: CertificateKind;
  /** Omitted means "use the configured fee"; pass 0 to issue this one free. */
  amount?: string;
  note?: string | null;
  /** The month to bill it to. Defaults to the current one. */
  year?: number;
  month?: number;
}

/**
 * Record that a certificate was issued, and charge for it.
 *
 * The charge lands on the student's challan for the month, which is created if
 * they have none — a certificate issued mid-month to someone not yet billed
 * still has to be collectable.
 */
export async function recordCertificateIssue(actor: Actor, input: RecordIssueInput) {
  const student = await prisma.student.findUnique({
    where: { id: input.studentId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      admissionNo: true,
      status: true,
      teacherParentId: true,
      section: { select: { class: { select: { name: true } } } },
    },
  });
  if (!student) throw NotFound('Student not found');

  const today = pktDay();
  const year = input.year ?? today.getUTCFullYear();
  const month = input.month ?? today.getUTCMonth() + 1;

  // The configured price unless the office overrode it for this one.
  const configured = await prisma.certificateFee.findUnique({ where: { kind: input.kind } });
  const fee =
    input.amount !== undefined
      ? money(input.amount)
      : configured && configured.active
        ? money(configured.amount)
        : ZERO;
  if (fee.lessThan(0)) throw new AppError('A fee cannot be negative', 400, 'INVALID_AMOUNT');

  const studentName = `${student.firstName}${student.lastName ? ` ${student.lastName}` : ''}`;

  const result = await prisma.$transaction(async (tx) => {
    const serial = await nextSerial(tx, input.kind, year);
    let challanId: string | null = null;
    let challanNo: string | null = null;
    let created = false;

    if (fee.greaterThan(0)) {
      let challan = await tx.feeChallan.findUnique({
        where: { studentId_year_month: { studentId: student.id, year, month } },
        select: { id: true, challanNo: true, status: true },
      });

      if (challan && challan.status === 'PAID') {
        throw new AppError(
          `${studentName}'s challan for this month is already fully paid, so the fee cannot be added to it. ` +
            'Choose another month, or reverse the payment first.',
          409,
          'CHALLAN_PAID',
        );
      }

      if (!challan) {
        // No bill this month — raise one carrying just this charge, due today.
        const no = await nextChallanNoTx(tx, year);
        challan = await tx.feeChallan.create({
          data: {
            challanNo: no,
            studentId: student.id,
            year,
            month,
            baseAmount: '0.00',
            discount: '0.00',
            amount: '0.00',
            dueDate: today,
            billedToTeacherId: student.teacherParentId ?? null,
          },
          select: { id: true, challanNo: true, status: true },
        });
        created = true;
      }

      await tx.feeChallanItem.create({
        data: {
          challanId: challan.id,
          type: FeeItemType.CERTIFICATE,
          label: `${CERTIFICATE_LABEL[input.kind]} (${serial})`,
          amount: toMoneyString(fee),
        },
      });

      // Fold the new line into the challan's totals the same way an edit does.
      const items = await tx.feeChallanItem.findMany({ where: { challanId: challan.id } });
      const base = items.reduce((acc, i) => acc.plus(money(i.amount)), ZERO);
      const current = await tx.feeChallan.findUniqueOrThrow({
        where: { id: challan.id },
        select: { discount: true, lateFee: true },
      });
      const discount = round2(Prisma.Decimal.min(money(current.discount), base));
      await tx.feeChallan.update({
        where: { id: challan.id },
        data: {
          baseAmount: toMoneyString(base),
          discount: toMoneyString(discount),
          amount: toMoneyString(round2(base.minus(discount).plus(money(current.lateFee)))),
        },
      });
      await recomputeChallan(tx, challan.id);

      challanId = challan.id;
      challanNo = challan.challanNo;
    }

    const issue = await tx.certificateIssue.create({
      data: {
        studentId: student.id,
        kind: input.kind,
        amount: toMoneyString(fee),
        serial,
        challanId,
        issuedById: actor.userId,
        note: input.note ?? null,
      },
    });

    const actorUser = await tx.user.findUnique({
      where: { id: actor.userId },
      select: { fullName: true, role: true },
    });
    await tx.auditLog.create({
      data: {
      actorId: actor.userId,
      actorName: actorUser?.fullName ?? 'Admin',
      actorRole: actorUser?.role ?? 'ADMIN',
      action: 'CREATE',
      module: 'CERTIFICATES',
      targetType: 'CertificateIssue',
      targetId: issue.id,
      targetLabel: `${CERTIFICATE_LABEL[input.kind]} — ${studentName} (${student.admissionNo})`,
      details:
        `${actorUser?.fullName ?? 'Admin'} issued a ${CERTIFICATE_LABEL[input.kind]} (${serial}) to ${studentName} ` +
        `(${student.admissionNo}, ${student.section.class.name})` +
        (fee.greaterThan(0)
          ? `, charging Rs ${toMoneyString(fee)} on challan ${challanNo}${created ? ' (raised for this charge)' : ''}`
          : ', free of charge') +
        (input.note ? `. Note: ${input.note}` : '') +
        '.',
      changes: {
        _meta: {
          serial,
          kind: input.kind,
          student: `${studentName} (${student.admissionNo})`,
          amount: toMoneyString(fee),
          billedTo: challanNo,
          challanRaisedForThis: created,
          period: `${year}-${String(month).padStart(2, '0')}`,
        },
      },
      },
    });

    return { issue, serial, challanNo, created };
  }, { timeout: 60_000, maxWait: 20_000 });

  return {
    id: result.issue.id,
    serial: result.serial,
    kind: input.kind,
    label: CERTIFICATE_LABEL[input.kind],
    studentId: student.id,
    studentName,
    admissionNo: student.admissionNo,
    amount: toMoneyString(fee),
    challanNo: result.challanNo,
    challanRaised: result.created,
    issuedAt: result.issue.issuedAt.toISOString(),
  };
}

/** The next challan number for a year, matching the fees module's format. */
async function nextChallanNoTx(tx: Prisma.TransactionClient, year: number) {
  const prefix = `CH-${year}-`;
  const last = await tx.feeChallan.findFirst({
    where: { challanNo: { startsWith: prefix } },
    orderBy: { challanNo: 'desc' },
    select: { challanNo: true },
  });
  const n = last ? Number(last.challanNo.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(n).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export async function listCertificateIssues(query: {
  studentId?: string;
  kind?: CertificateKind;
  from?: string;
  to?: string;
}) {
  const rows = await prisma.certificateIssue.findMany({
    where: {
      ...(query.studentId ? { studentId: query.studentId } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.from || query.to
        ? {
            issuedAt: {
              ...(query.from ? { gte: parsePktDay(query.from) } : {}),
              ...(query.to ? { lte: new Date(parsePktDay(query.to).getTime() + 86_399_999) } : {}),
            },
          }
        : {}),
    },
    include: {
      student: {
        select: {
          firstName: true,
          lastName: true,
          admissionNo: true,
          status: true,
          section: { select: { name: true, isDefault: true, class: { select: { name: true } } } },
        },
      },
      issuedBy: { select: { fullName: true } },
      challan: { select: { challanNo: true, status: true } },
    },
    orderBy: { issuedAt: 'desc' },
    take: 500,
  });

  return rows.map((r) => ({
    id: r.id,
    serial: r.serial,
    kind: r.kind,
    label: CERTIFICATE_LABEL[r.kind],
    amount: toMoneyString(r.amount),
    studentId: r.studentId,
    studentName: `${r.student.firstName}${r.student.lastName ? ` ${r.student.lastName}` : ''}`,
    admissionNo: r.student.admissionNo,
    studentStatus: r.student.status,
    className: r.student.section.class.name,
    sectionName: r.student.section.name,
    isDefault: r.student.section.isDefault,
    issuedBy: r.issuedBy.fullName,
    issuedAt: r.issuedAt.toISOString(),
    issuedOn: pktDayString(r.issuedAt),
    // Null when issued free, or when the challan it was billed to was deleted.
    challanNo: r.challan?.challanNo ?? null,
    challanStatus: r.challan?.status ?? null,
    note: r.note,
  }));
}

/** Totals for the certificates tab: how many issued, and what it came to. */
export async function certificatesSummary(from?: string, to?: string) {
  const where =
    from || to
      ? {
          issuedAt: {
            ...(from ? { gte: parsePktDay(from) } : {}),
            ...(to ? { lte: new Date(parsePktDay(to).getTime() + 86_399_999) } : {}),
          },
        }
      : {};
  const rows = await prisma.certificateIssue.findMany({ where, select: { kind: true, amount: true } });
  const byKind = Object.values(CertificateKind).map((kind) => {
    const mine = rows.filter((r) => r.kind === kind);
    return {
      kind,
      label: CERTIFICATE_LABEL[kind],
      count: mine.length,
      total: toMoneyString(mine.reduce((acc, r) => acc.plus(money(r.amount)), ZERO)),
    };
  });
  return {
    issued: rows.length,
    total: toMoneyString(rows.reduce((acc, r) => acc.plus(money(r.amount)), ZERO)),
    byKind,
  };
}
