/**
 * Move transport fares that were taken out of salary onto transport challans.
 *
 * Before transport had challans of its own, payroll deducted a staff rider's
 * fare from their pay. Those slips are already paid, so the pay itself is left
 * exactly as it was. What moves is the RECORD: each deducted fare becomes a
 * transport challan for that month, settled by a SALARY_DEDUCTION payment
 * linked to the slip. The Transport page then shows the month as paid, and
 * generating that month again cannot bill the rider a second time.
 *
 * Dry run by default — prints what it would create and writes nothing:
 *   npx tsx scripts/move-salary-transport-to-challans.ts
 * Then, after checking the list:
 *   npx tsx scripts/move-salary-transport-to-challans.ts --apply
 *
 * Safe to re-run: a rider who already has a transport challan for the month is
 * skipped.
 */
import { ChallanStatus, Prisma, TransportPaymentMethod } from '@prisma/client';
import { prisma } from '../src/config/prisma';
import { money, round2, sum, toMoneyString } from '../src/utils/money';
import { pktDay, pktDayString } from '../src/utils/pktDate';

const APPLY = process.argv.includes('--apply');
const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface Planned {
  slipId: string;
  teacherId: string;
  employeeId: string;
  name: string;
  year: number;
  month: number;
  fare: Prisma.Decimal;
  routeId: string | null;
  routeName: string;
  routeSource: string;
  slipStatus: string;
  issueDate: Date;
  paidOn: Date;
  receivedById: string;
}

/** The route a staff member rode, from their assignment now or the audit trail. */
async function routeFor(teacher: { id: string; employeeId: string; transportAssignment: { routeId: string; route: { name: string } } | null }) {
  if (teacher.transportAssignment) {
    return { routeId: teacher.transportAssignment.routeId, routeName: teacher.transportAssignment.route.name, source: 'current route' };
  }
  // Taken off their route since: the assignment entries name the route and carry
  // the employee ID in their details.
  const log = await prisma.auditLog.findFirst({
    where: {
      targetType: 'TransportRoute',
      action: { in: ['TRANSPORT_ASSIGNED', 'TRANSPORT_UNASSIGNED'] },
      details: { contains: teacher.employeeId },
    },
    orderBy: { timestamp: 'desc' },
  });
  if (log?.targetId) {
    const route = await prisma.transportRoute.findUnique({ where: { id: log.targetId }, select: { id: true, name: true } });
    return { routeId: route?.id ?? null, routeName: route?.name ?? log.targetLabel, source: 'audit log' };
  }
  return { routeId: null, routeName: 'School transport', source: 'unknown — no route on record' };
}

async function main() {
  const slips = await prisma.salarySlip.findMany({
    where: { staffFeeDeduction: { gt: 0 } },
    orderBy: [{ year: 'asc' }, { month: 'asc' }],
    include: {
      teacher: {
        select: {
          id: true,
          employeeId: true,
          user: { select: { fullName: true } },
          transportAssignment: { select: { routeId: true, route: { select: { name: true } } } },
        },
      },
    },
  });

  const planned: Planned[] = [];
  const skipped: string[] = [];

  for (const s of slips) {
    // The slip stores one blended deduction; the children's challans record
    // what they absorbed, and the rest was the staff member's own fare.
    const children = await prisma.feeChallan.findMany({
      where: { billedToTeacherId: s.teacherId, year: s.year, month: s.month },
      select: { staffCovered: true },
    });
    const fare = round2(money(s.staffFeeDeduction).minus(sum(children.map((c) => c.staffCovered))));
    const who = `${s.teacher.employeeId} ${s.teacher.user.fullName}, ${MONTHS[s.month]} ${s.year}`;
    if (fare.lessThanOrEqualTo(0)) {
      skipped.push(`${who}: deduction was all children's fees, no transport`);
      continue;
    }
    const existing = await prisma.transportChallan.findUnique({
      where: { teacherId_year_month: { teacherId: s.teacherId, year: s.year, month: s.month } },
      select: { challanNo: true },
    });
    if (existing) {
      skipped.push(`${who}: already has transport challan ${existing.challanNo}`);
      continue;
    }
    const route = await routeFor(s.teacher);
    planned.push({
      slipId: s.id,
      teacherId: s.teacherId,
      employeeId: s.teacher.employeeId,
      name: s.teacher.user.fullName,
      year: s.year,
      month: s.month,
      fare,
      routeId: route.routeId,
      routeName: route.routeName,
      routeSource: route.source,
      slipStatus: s.status,
      issueDate: s.createdAt,
      paidOn: s.paidDate ?? s.createdAt,
      receivedById: s.generatedById,
    });
  }

  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN — nothing will be written'}\n`);
  for (const p of planned) {
    console.log(
      `  ${p.employeeId.padEnd(9)} ${p.name.padEnd(24)} ${`${MONTHS[p.month]} ${p.year}`.padEnd(15)} ` +
        `Rs ${toMoneyString(p.fare).padStart(8)}  ${p.routeName} (${p.routeSource})  slip ${p.slipStatus}, paid ${pktDayString(p.paidOn)}`,
    );
  }
  console.log(`\n  to create: ${planned.length} transport challan(s), Rs ${toMoneyString(sum(planned.map((p) => p.fare)))} in total`);
  for (const s of skipped) console.log(`  skipped: ${s}`);

  if (!APPLY || planned.length === 0) {
    if (!APPLY && planned.length > 0) console.log('\nRe-run with --apply to write these.\n');
    return;
  }

  const created = await prisma.$transaction(
    async (tx) => {
      const out: { challanNo: string; p: Planned }[] = [];
      for (const p of planned) {
        const counter = await tx.transportChallanCounter.upsert({
          where: { year: p.year },
          create: { year: p.year, lastNumber: 1 },
          update: { lastNumber: { increment: 1 } },
        });
        const challanNo = `TR-${p.year}-${String(counter.lastNumber).padStart(6, '0')}`;
        const period = `${MONTHS[p.month]} ${p.year}`;
        const challan = await tx.transportChallan.create({
          data: {
            challanNo,
            teacherId: p.teacherId,
            routeId: p.routeId,
            routeName: p.routeName,
            year: p.year,
            month: p.month,
            baseAmount: p.fare,
            amount: p.fare,
            issueDate: p.issueDate,
            dueDate: pktDay(p.paidOn),
            status: ChallanStatus.PAID,
            generatedById: p.receivedById,
            note: `Deducted from the ${period} salary, before transport was billed on its own challans.`,
          },
        });
        await tx.transportPayment.create({
          data: {
            challanId: challan.id,
            amount: p.fare,
            paymentDate: pktDay(p.paidOn),
            method: TransportPaymentMethod.SALARY_DEDUCTION,
            receivedById: p.receivedById,
            salarySlipId: p.slipId,
            note: `Deducted from ${period} salary`,
          },
        });
        out.push({ challanNo, p });
      }
      return out;
    },
    { timeout: 60_000, maxWait: 20_000 },
  );

  await prisma.auditLog.create({
    data: {
      actorName: 'System migration',
      actorRole: 'SUPERADMIN',
      action: 'CREATE',
      module: 'FEES',
      targetType: 'TransportChallan',
      targetLabel: 'Salary transport deductions moved to transport challans',
      details:
        `Recorded ${created.length} transport fare(s) previously deducted from salary as paid transport challans ` +
        `(Rs ${toMoneyString(sum(created.map((c) => c.p.fare)))}). Salary slips were not changed.`,
      changes: {
        _meta: {
          challans: created.map((c) => ({
            challanNo: c.challanNo,
            staff: `${c.p.name} (${c.p.employeeId})`,
            period: `${MONTHS[c.p.month]} ${c.p.year}`,
            amount: toMoneyString(c.p.fare),
            route: c.p.routeName,
            salarySlipId: c.p.slipId,
          })),
        },
      },
    },
  });

  console.log(`\nCreated ${created.length}: ${created.map((c) => c.challanNo).join(', ')}\n`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
