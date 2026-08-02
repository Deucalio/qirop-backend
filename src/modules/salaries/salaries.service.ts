import { Prisma, Role, UserStatus, FeeItemType } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError, NotFound } from '../../utils/apiResponse';
import { money, sum, round2, toMoneyString, ZERO, Decimal, type Money } from '../../utils/money';
import { pktDay, pktDayString, parsePktDay } from '../../utils/pktDate';
import { publicUrl } from '../../services/storage';
import { recomputeChallan } from '../fees/fees.service';
import { logAudit } from '../audit/audit.service';
import type { GenerateSalariesInput, UpdateSalaryInput, ListSalariesQuery } from './salaries.schema';

export interface Actor {
  userId: string;
  role: Role;
}

/** A staff-billed challan's salary-billable amount = total − cash already paid. */
function billableOf(c: {
  amount: Prisma.Decimal;
  items: { type: FeeItemType; amount: Prisma.Decimal }[];
  allocations: { amountApplied: Prisma.Decimal; payment: { isReversed: boolean } }[];
}): Money {
  const cash = sum(c.allocations.filter((a) => !a.payment.isReversed).map((a) => a.amountApplied));
  return round2(Decimal.max(0, money(c.amount).minus(cash)));
}

// ---------------------------------------------------------------------------
// Generation — the settlement (§7)
// ---------------------------------------------------------------------------

export async function generateSalaries(actor: Actor, input: GenerateSalariesInput) {
  const { year, month } = input;
  const teachers = await prisma.teacherProfile.findMany({
    where: { status: UserStatus.ACTIVE, ...(input.teacherIds ? { id: { in: input.teacherIds } } : {}) },
    include: { user: true, transportAssignment: { include: { route: true } } },
  });

  return prisma.$transaction(
    async (tx) => {
      let created = 0;
      let skipped = 0;
      let totalNet = ZERO;
      let totalStaffDeduction = ZERO;

      for (const t of teachers) {
        const exists = await tx.salarySlip.findUnique({
          where: { teacherId_year_month: { teacherId: t.id, year, month } },
        });
        if (exists) {
          skipped++;
          continue;
        }

        const basic = money(t.salary);
        const netBefore = basic; // allowances/deductions are 0 at generation

        const ownTransport = t.transportAssignment?.route?.active
          ? money(t.transportAssignment.route.monthlyFee)
          : ZERO;

        const childChallans = await tx.feeChallan.findMany({
          where: { billedToTeacherId: t.id, year, month },
          include: { items: true, allocations: { include: { payment: true } }, student: true },
          orderBy: { createdAt: 'asc' },
        });

        const billables = childChallans.map((c) => ({ challan: c, billable: billableOf(c) }));
        const desired = ownTransport.plus(sum(billables.map((b) => b.billable)));
        // Cap so net never goes below 0 (§7.3).
        const staffFee = round2(Decimal.min(desired, Decimal.max(0, netBefore)));

        // Allocate the capped amount: own transport first, then children oldest-first.
        let remaining = staffFee;
        const coveredTransport = round2(Decimal.min(ownTransport, remaining));
        remaining = remaining.minus(coveredTransport);

        for (const b of billables) {
          const cover = round2(Decimal.min(b.billable, remaining));
          await tx.feeChallan.update({ where: { id: b.challan.id }, data: { staffCovered: toMoneyString(cover) } });
          await recomputeChallan(tx, b.challan.id);
          remaining = remaining.minus(cover);
        }

        const childrenCovered = staffFee.minus(coveredTransport);
        const uncovered = round2(sum(billables.map((b) => b.billable)).minus(childrenCovered));
        const net = round2(netBefore.minus(staffFee));

        const notes = buildNotes({
          childCount: billables.length,
          childNames: billables.map((b) => `${b.challan.student.firstName} ${b.challan.student.lastName}`),
          coveredTransport,
          childrenCovered: round2(childrenCovered),
          uncovered,
        });

        await tx.salarySlip.create({
          data: {
            teacherId: t.id,
            year,
            month,
            basicSalary: toMoneyString(basic),
            allowances: '0',
            deductions: '0',
            staffFeeDeduction: toMoneyString(staffFee),
            netSalary: toMoneyString(net),
            notes,
            status: 'PENDING',
            generatedById: actor.userId,
          },
        });
        created++;
        totalNet = totalNet.plus(net);
        totalStaffDeduction = totalStaffDeduction.plus(staffFee);
      }

      const actorUser = await tx.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          actorName: actorUser?.fullName ?? 'Admin',
          actorRole: actor.role,
          action: 'CREATE',
          module: 'SALARIES',
          targetType: 'SalarySlip',
          targetId: `${year}-${month}`,
          targetLabel: `Monthly Salary Slips (${year}-${String(month).padStart(2, '0')})`,
          details: `Admin batch generated ${created} salary slips for term ${year}-${String(month).padStart(2, '0')}`,
        },
      });

      return { created, skipped, totalNet: toMoneyString(totalNet), totalStaffDeduction: toMoneyString(totalStaffDeduction) };
    },
    { timeout: 120_000, maxWait: 20_000 },
  );
}

function buildNotes(x: {
  childCount: number;
  childNames: string[];
  coveredTransport: Money;
  childrenCovered: Money;
  uncovered: Money;
}): string | null {
  const parts: string[] = [];
  if (x.coveredTransport.greaterThan(0)) parts.push(`Rs ${x.coveredTransport} own transport`);
  if (x.childrenCovered.greaterThan(0)) {
    const names = x.childNames.slice(0, 4).join(', ') + (x.childNames.length > 4 ? '…' : '');
    parts.push(`Rs ${x.childrenCovered} for ${x.childCount} child challan${x.childCount === 1 ? '' : 's'} (${names})`);
  }
  if (parts.length === 0) return null;
  let note = `Salary absorbed ${parts.join(' + ')}.`;
  if (x.uncovered.greaterThan(0)) note += ` Rs ${x.uncovered} could not be covered and stays payable on the children's challans.`;
  return note;
}

// ---------------------------------------------------------------------------
// Reads + edits
// ---------------------------------------------------------------------------

function shapeSlip(s: {
  id: string;
  teacherId: string;
  year: number;
  month: number;
  basicSalary: Prisma.Decimal;
  allowances: Prisma.Decimal;
  deductions: Prisma.Decimal;
  staffFeeDeduction: Prisma.Decimal;
  netSalary: Prisma.Decimal;
  notes: string | null;
  status: string;
  paidDate: Date | null;
  teacher: { employeeId: string; user: { fullName: string; avatarUrl: string | null } };
}) {
  return {
    id: s.id,
    teacherId: s.teacherId,
    teacherName: s.teacher.user.fullName,
    avatarUrl: publicUrl(s.teacher.user.avatarUrl),
    employeeId: s.teacher.employeeId,
    year: s.year,
    month: s.month,
    basicSalary: toMoneyString(s.basicSalary),
    allowances: toMoneyString(s.allowances),
    deductions: toMoneyString(s.deductions),
    staffFeeDeduction: toMoneyString(s.staffFeeDeduction),
    netSalary: toMoneyString(s.netSalary),
    notes: s.notes,
    status: s.status,
    paidDate: s.paidDate ? pktDayString(s.paidDate) : null,
  };
}

/**
 * Preflight for the Generate Salaries flow. A staff child's fee is only pulled
 * from their teacher-parent's salary if a challan for the month already exists
 * and is billed to that teacher. This reports the staff children for whom that
 * isn't true yet, so the UI can warn "generate challans first" before the admin
 * generates salaries and silently misses the deduction.
 */
export async function salaryGenerationPreflight(year: number, month: number) {
  const staffChildren = await prisma.student.findMany({
    where: { status: UserStatus.ACTIVE, teacherParentId: { not: null } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      teacherParentId: true,
      section: { select: { name: true, class: { select: { name: true } } } },
      teacherParent: { select: { status: true, user: { select: { fullName: true } } } },
      challans: { where: { year, month }, select: { billedToTeacherId: true } },
    },
  });

  // Only active teacher-parents get a slip — those are the children whose fees
  // this run could deduct.
  const eligible = staffChildren.filter((s) => s.teacherParent?.status === UserStatus.ACTIVE);
  // Missing = no challan for the month billed to that teacher (absent OR a stale
  // billedToTeacherId === null), so the fee won't be deducted this run.
  const missing = eligible.filter(
    (s) => !s.challans.some((c) => c.billedToTeacherId === s.teacherParentId),
  );

  const teacherIds = new Set(missing.map((s) => s.teacherParentId));
  return {
    year,
    month,
    staffChildrenTotal: eligible.length,
    staffChildrenMissing: missing.length,
    teachersAffected: teacherIds.size,
    students: missing.slice(0, 15).map((s) => ({
      name: `${s.firstName} ${s.lastName}`,
      className: `${s.section.class.name}-${s.section.name}`,
      teacherName: s.teacherParent?.user.fullName ?? '',
    })),
  };
}

export async function listSalaries(query: ListSalariesQuery) {
  // Coerce defensively: even if a caller bypasses the schema, year/month must be
  // numbers for Prisma's Int filter (they arrive as strings from req.query).
  const year = query.year != null ? Number(query.year) : undefined;
  const month = query.month != null ? Number(query.month) : undefined;
  const slips = await prisma.salarySlip.findMany({
    where: {
      ...(year ? { year } : {}),
      ...(month ? { month } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.teacherId ? { teacherId: query.teacherId } : {}),
    },
    include: { teacher: { include: { user: true } } },
    orderBy: [{ year: 'desc' }, { month: 'desc' }, { teacher: { user: { fullName: 'asc' } } }],
    take: 1000,
  });
  return slips.map(shapeSlip);
}

/** A salary slip with the full staff-fee deduction breakdown (children + transport). */
export async function getSalary(id: string) {
  const s = await prisma.salarySlip.findUnique({
    where: { id },
    include: {
      teacher: {
        include: {
          user: true,
          transportAssignment: { include: { route: true } },
          _count: { select: { staffChildren: true } },
        },
      },
    },
  });
  if (!s) throw NotFound('Salary slip not found');

  const childChallans = await prisma.feeChallan.findMany({
    where: { billedToTeacherId: s.teacherId, year: s.year, month: s.month },
    include: { items: true, allocations: { include: { payment: true } }, student: true },
    orderBy: { createdAt: 'asc' },
  });

  // Each child's earlier unpaid months (dues carried from before this slip's month),
  // so the slip can show what still stands against the child besides this month.
  const studentIds = [...new Set(childChallans.map((c) => c.studentId))];
  const priorChallans = studentIds.length
    ? await prisma.feeChallan.findMany({
        where: {
          studentId: { in: studentIds },
          OR: [{ year: { lt: s.year } }, { year: s.year, month: { lt: s.month } }],
        },
        select: {
          studentId: true,
          year: true,
          month: true,
          amount: true,
          staffCovered: true,
          allocations: { where: { payment: { isReversed: false } }, select: { amountApplied: true } },
        },
        orderBy: [{ year: 'asc' }, { month: 'asc' }],
      })
    : [];
  const duesByStudent = new Map<string, { year: number; month: number; balance: string }[]>();
  for (const p of priorChallans) {
    const cash = sum(p.allocations.map((a) => a.amountApplied));
    const balance = round2(money(p.amount).minus(p.staffCovered).minus(cash));
    if (balance.greaterThan(0)) {
      const list = duesByStudent.get(p.studentId) ?? [];
      list.push({ year: p.year, month: p.month, balance: toMoneyString(balance) });
      duesByStudent.set(p.studentId, list);
    }
  }

  const children = childChallans.map((c) => ({
    challanId: c.id,
    challanNo: c.challanNo,
    studentName: `${c.student.firstName} ${c.student.lastName}`,
    period: { year: c.year, month: c.month },
    billable: toMoneyString(billableOf(c)),
    covered: toMoneyString(c.staffCovered),
    payable: toMoneyString(round2(Decimal.max(0, billableOf(c).minus(money(c.staffCovered))))),
    previousDues: duesByStudent.get(c.studentId) ?? [],
  }));

  const childrenCovered = sum(childChallans.map((c) => c.staffCovered));
  const transportCovered = round2(Decimal.max(0, money(s.staffFeeDeduction).minus(childrenCovered)));
  const totalPayable = round2(sum(children.map((c) => c.payable)));

  const ownRoute = s.teacher.transportAssignment?.route;
  return {
    ...shapeSlip(s),
    breakdown: {
      transportRoute: ownRoute?.name ?? null,
      // The teacher's own commute fee (shown even if the salary didn't cover it).
      transportFee: toMoneyString(ownRoute?.active ? ownRoute.monthlyFee : 0),
      transportCovered: toMoneyString(transportCovered),
      childrenCovered: toMoneyString(childrenCovered),
      children,
      // How many of this teacher's children are enrolled — so the modal can show
      // context even in a month with no generated challans.
      childrenEnrolled: s.teacher._count.staffChildren,
      uncoveredPayable: toMoneyString(totalPayable),
    },
  };
}

// ---------------------------------------------------------------------------
// Salary structure — set each teacher's monthly salary in one place
// ---------------------------------------------------------------------------

/** Every active teacher with their salary + the context that affects their pay. */
export async function listSalaryStructure() {
  const teachers = await prisma.teacherProfile.findMany({
    where: { status: UserStatus.ACTIVE },
    include: {
      user: { select: { fullName: true, avatarUrl: true } },
      transportAssignment: { include: { route: true } },
      _count: { select: { staffChildren: true } },
    },
    orderBy: { user: { fullName: 'asc' } },
  });
  return teachers.map((t) => ({
    id: t.id,
    name: t.user.fullName,
    avatarUrl: publicUrl(t.user.avatarUrl),
    employeeId: t.employeeId,
    salary: toMoneyString(t.salary),
    childrenEnrolled: t._count.staffChildren,
    transport: t.transportAssignment?.route
      ? { name: t.transportAssignment.route.name, monthlyFee: toMoneyString(t.transportAssignment.route.monthlyFee) }
      : null,
  }));
}

export async function setTeacherSalary(actor: Actor, teacherId: string, salary: string) {
  const t = await prisma.teacherProfile.findUnique({ where: { id: teacherId }, include: { user: true } });
  if (!t) throw NotFound('Teacher not found');
  const updated = await prisma.teacherProfile.update({ where: { id: teacherId }, data: { salary } });
  const actorUser = await prisma.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorName: actorUser?.fullName ?? 'Admin',
      actorRole: actor.role,
      action: 'UPDATE',
      module: 'SALARIES',
      targetType: 'TeacherProfile',
      targetId: teacherId,
      targetLabel: `Salary structure — ${t.user.fullName}`,
      details: `Admin set ${t.user.fullName}'s monthly salary to Rs ${toMoneyString(salary)}`,
      changes: { salary: { before: t.salary.toString(), after: toMoneyString(salary) } },
    },
  });
  return { id: teacherId, salary: toMoneyString(updated.salary) };
}

export async function updateSalary(actor: Actor, id: string, input: UpdateSalaryInput) {
  const s = await prisma.salarySlip.findUnique({ where: { id } });
  if (!s) throw NotFound('Salary slip not found');
  if (s.status === 'PAID') throw new AppError('This slip is already paid and cannot be edited', 409, 'SLIP_PAID');

  const allowances = input.allowances !== undefined ? money(input.allowances) : money(s.allowances);
  const deductions = input.deductions !== undefined ? money(input.deductions) : money(s.deductions);
  // net = basic + allowances − deductions − staffFeeDeduction (staff fee is fixed at generation).
  const net = round2(money(s.basicSalary).plus(allowances).minus(deductions).minus(money(s.staffFeeDeduction)));

  const updated = await prisma.salarySlip.update({
    where: { id },
    data: {
      allowances: toMoneyString(allowances),
      deductions: toMoneyString(deductions),
      netSalary: toMoneyString(net),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    },
    include: { teacher: { include: { user: true } } },
  });
  const actorUser = await prisma.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorName: actorUser?.fullName ?? 'Admin',
      actorRole: actor.role,
      action: 'UPDATE',
      module: 'SALARIES',
      targetType: 'SalarySlip',
      targetId: id,
      targetLabel: `Salary Slip for ${updated.teacher.user.fullName}`,
      details: `Admin updated allowances/deductions for ${updated.teacher.user.fullName}'s salary slip`,
      changes: {
        allowances: { before: s.allowances.toString(), after: allowances.toString() },
        deductions: { before: s.deductions.toString(), after: deductions.toString() },
      },
    },
  });
  return shapeSlip(updated);
}

export async function setSalaryStatus(actor: Actor, id: string, status: 'PENDING' | 'PAID', paidDate?: string) {
  const s = await prisma.salarySlip.findUnique({ where: { id }, include: { teacher: { include: { user: true } } } });
  if (!s) throw NotFound('Salary slip not found');
  const updated = await prisma.salarySlip.update({
    where: { id },
    data: {
      status,
      paidDate: status === 'PAID' ? (paidDate ? parsePktDay(paidDate) : pktDay()) : null,
    },
    include: { teacher: { include: { user: true } } },
  });
  const actorUser = await prisma.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorName: actorUser?.fullName ?? 'Admin',
      actorRole: actor.role,
      action: 'UPDATE',
      module: 'SALARIES',
      targetType: 'SalarySlip',
      targetId: id,
      targetLabel: `Salary Slip for ${updated.teacher.user.fullName}`,
      details: `Admin marked ${updated.teacher.user.fullName}'s salary slip as ${status}`,
      changes: {
        status: { before: s.status, after: status },
      },
    },
  });
  return shapeSlip(updated);
}

/** Mark many salary slips paid at once (payday). Already-paid slips are skipped. */
export async function markSalariesPaid(actor: Actor, slipIds: string[], paidDate?: string) {
  const when = paidDate ? parsePktDay(paidDate) : pktDay();
  const res = await prisma.salarySlip.updateMany({
    where: { id: { in: slipIds }, status: 'PENDING' },
    data: { status: 'PAID', paidDate: when },
  });
  const actorUser = await prisma.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorName: actorUser?.fullName ?? 'Admin',
      actorRole: actor.role,
      action: 'UPDATE',
      module: 'SALARIES',
      targetType: 'SalarySlip',
      targetId: `${res.count} slips`,
      targetLabel: `Payroll disbursed (${res.count} slips)`,
      details: `Admin marked ${res.count} salary slip${res.count === 1 ? '' : 's'} as paid`,
    },
  });
  return { paid: res.count, skipped: slipIds.length - res.count };
}

/** Month-scoped payroll summary (for the dashboard/overview). */
export async function salariesSummary(year: number, month: number) {
  const slips = await prisma.salarySlip.findMany({ where: { year, month } });
  const totalNet = sum(slips.map((s) => s.netSalary));
  const totalBasic = sum(slips.map((s) => s.basicSalary));
  const totalStaffDeduction = sum(slips.map((s) => s.staffFeeDeduction));
  const paid = slips.filter((s) => s.status === 'PAID');
  return {
    year,
    month,
    slips: slips.length,
    paidCount: paid.length,
    totalNet: toMoneyString(totalNet),
    totalBasic: toMoneyString(totalBasic),
    totalStaffDeduction: toMoneyString(totalStaffDeduction),
    paidNet: toMoneyString(sum(paid.map((s) => s.netSalary))),
  };
}

export async function listMySlips(userId: string) {
  const profile = await prisma.teacherProfile.findUnique({ where: { userId } });
  if (!profile) return [];

  const slips = await prisma.salarySlip.findMany({
    where: { teacherId: profile.id },
    include: { teacher: { include: { user: true } } },
    orderBy: [{ year: 'desc' }, { month: 'desc' }],
  });
  return slips.map(shapeSlip);
}

export async function getMySlipDetail(userId: string, id: string) {
  const profile = await prisma.teacherProfile.findUnique({ where: { userId } });
  if (!profile) throw NotFound('Teacher profile not found');

  const slip = await prisma.salarySlip.findFirst({
    where: { id, teacherId: profile.id },
  });
  if (!slip) throw NotFound('Salary slip not found');

  return getSalary(id);
}

export async function deleteSalariesForMonth(actor: Actor, year: number, month: number) {
  const slips = await prisma.salarySlip.findMany({
    where: { year, month },
    select: { id: true },
  });

  if (slips.length === 0) {
    throw new AppError(`No salary slips found for ${year}-${String(month).padStart(2, '0')}`, 404, 'NOT_FOUND');
  }

  const res = await prisma.salarySlip.deleteMany({
    where: { year, month },
  });

  const actorUser = await prisma.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorName: actorUser?.fullName ?? 'Admin',
      actorRole: actor.role,
      action: 'DELETE',
      module: 'SALARIES',
      targetType: 'SalarySlip',
      targetId: `${year}-${month}`,
      targetLabel: `All Salary Slips for ${year}-${String(month).padStart(2, '0')} (${res.count} slips)`,
      details: `${actorUser?.fullName ?? 'Admin'} deleted all ${res.count} salary slip(s) for ${year}-${String(month).padStart(2, '0')}`,
      changes: {
        deletedCount: { before: res.count, after: 0 },
      },
    },
  });

  return { deleted: res.count, year, month };
}
