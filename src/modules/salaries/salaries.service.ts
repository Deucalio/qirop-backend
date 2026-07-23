import { Prisma, Role, UserStatus, FeeItemType } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError, NotFound } from '../../utils/apiResponse';
import { money, sum, round2, toMoneyString, ZERO, Decimal, type Money } from '../../utils/money';
import { pktDay, pktDayString, parsePktDay } from '../../utils/pktDate';
import { recomputeChallan } from '../fees/fees.service';
import type { GenerateSalariesInput, UpdateSalaryInput, ListSalariesQuery } from './salaries.schema';

export interface Actor {
  userId: string;
  role: Role;
}

/** A staff-billed challan's salary-billable amount = total − admission − cash already paid. */
function billableOf(c: {
  amount: Prisma.Decimal;
  items: { type: FeeItemType; amount: Prisma.Decimal }[];
  allocations: { amountApplied: Prisma.Decimal; payment: { isReversed: boolean } }[];
}): Money {
  const admission = sum(c.items.filter((i) => i.type === FeeItemType.ADMISSION).map((i) => i.amount));
  const cash = sum(c.allocations.filter((a) => !a.payment.isReversed).map((a) => a.amountApplied));
  return round2(Decimal.max(0, money(c.amount).minus(admission).minus(cash)));
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

      await tx.auditLog.create({
        data: {
          userId: actor.userId,
          action: 'SALARIES_GENERATED',
          entity: 'SalarySlip',
          entityId: `${year}-${month}`,
          metadata: { year, month, created, skipped, totalStaffDeduction: toMoneyString(totalStaffDeduction) },
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
  teacher: { employeeId: string; user: { fullName: string } };
}) {
  return {
    id: s.id,
    teacherId: s.teacherId,
    teacherName: s.teacher.user.fullName,
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

export async function listSalaries(query: ListSalariesQuery) {
  const slips = await prisma.salarySlip.findMany({
    where: {
      ...(query.year ? { year: query.year } : {}),
      ...(query.month ? { month: query.month } : {}),
      ...(query.status ? { status: query.status } : {}),
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
    include: { teacher: { include: { user: true, transportAssignment: { include: { route: true } } } } },
  });
  if (!s) throw NotFound('Salary slip not found');

  const childChallans = await prisma.feeChallan.findMany({
    where: { billedToTeacherId: s.teacherId, year: s.year, month: s.month },
    include: { items: true, allocations: { include: { payment: true } }, student: true },
    orderBy: { createdAt: 'asc' },
  });

  const children = childChallans.map((c) => ({
    challanId: c.id,
    challanNo: c.challanNo,
    studentName: `${c.student.firstName} ${c.student.lastName}`,
    billable: toMoneyString(billableOf(c)),
    covered: toMoneyString(c.staffCovered),
    payable: toMoneyString(round2(Decimal.max(0, billableOf(c).minus(money(c.staffCovered))))),
  }));

  const childrenCovered = sum(childChallans.map((c) => c.staffCovered));
  const transportCovered = round2(Decimal.max(0, money(s.staffFeeDeduction).minus(childrenCovered)));
  const totalPayable = round2(sum(children.map((c) => c.payable)));

  return {
    ...shapeSlip(s),
    breakdown: {
      transportRoute: s.teacher.transportAssignment?.route?.name ?? null,
      transportCovered: toMoneyString(transportCovered),
      childrenCovered: toMoneyString(childrenCovered),
      children,
      uncoveredPayable: toMoneyString(totalPayable),
    },
  };
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
  await prisma.auditLog.create({
    data: { userId: actor.userId, action: 'SALARY_UPDATED', entity: 'SalarySlip', entityId: id, metadata: { allowances: allowances.toString(), deductions: deductions.toString() } },
  });
  return shapeSlip(updated);
}

export async function setSalaryStatus(actor: Actor, id: string, status: 'PENDING' | 'PAID', paidDate?: string) {
  const s = await prisma.salarySlip.findUnique({ where: { id } });
  if (!s) throw NotFound('Salary slip not found');
  const updated = await prisma.salarySlip.update({
    where: { id },
    data: {
      status,
      paidDate: status === 'PAID' ? (paidDate ? parsePktDay(paidDate) : pktDay()) : null,
    },
    include: { teacher: { include: { user: true } } },
  });
  await prisma.auditLog.create({
    data: { userId: actor.userId, action: 'SALARY_STATUS_SET', entity: 'SalarySlip', entityId: id, metadata: { status } },
  });
  return shapeSlip(updated);
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
