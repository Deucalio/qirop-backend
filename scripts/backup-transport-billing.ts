/**
 * Read-only snapshot of every transport charge billed the old way.
 *
 * Transport is moving out of fee challans and salary slips into transport
 * challans of its own. Before a single row is moved, this records exactly what
 * exists: every route and rider, every fee challan carrying a TRANSPORT line
 * with the payments against it, and every salary slip that took transport out
 * of pay. Nothing here writes to the database.
 *
 * Output: `_transport_backup_<timestamp>.json` in the backend root. The `_`
 * prefix matters — .gitignore excludes `_*.json`, and these files hold real
 * names and fee records that must never reach the public repo.
 *
 *   npx tsx scripts/backup-transport-billing.ts
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { FeeItemType } from '@prisma/client';
import { prisma } from '../src/config/prisma';
import { money, sum, round2, toMoneyString, ZERO } from '../src/utils/money';
import { paidBreakdown } from '../src/modules/fees/fees.ledger';

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const period = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;

async function main() {
  // ---- Routes and who rides them -------------------------------------------
  const routes = await prisma.transportRoute.findMany({
    orderBy: { name: 'asc' },
    include: {
      assignments: {
        include: {
          student: {
            select: {
              id: true, admissionNo: true, firstName: true, lastName: true, status: true, teacherParentId: true,
              section: { select: { name: true, class: { select: { name: true } } } },
            },
          },
          teacher: { select: { id: true, employeeId: true, status: true, user: { select: { fullName: true } } } },
        },
      },
    },
  });

  // ---- Fee challans carrying a TRANSPORT line ------------------------------
  const transportItems = await prisma.feeChallanItem.findMany({
    where: { type: FeeItemType.TRANSPORT },
    select: { challanId: true },
  });
  const challanIds = [...new Set(transportItems.map((i) => i.challanId))];

  const challans = await prisma.feeChallan.findMany({
    where: { id: { in: challanIds } },
    orderBy: [{ year: 'asc' }, { month: 'asc' }, { challanNo: 'asc' }],
    include: {
      items: true,
      allocations: { include: { payment: true } },
      billedToTeacher: { select: { id: true, employeeId: true, user: { select: { fullName: true } } } },
      student: {
        select: {
          id: true, admissionNo: true, firstName: true, lastName: true, status: true, teacherParentId: true,
          section: { select: { name: true, class: { select: { name: true } } } },
          parent: { select: { user: { select: { fullName: true, phone: true } } } },
          transportAssignment: { select: { route: { select: { id: true, name: true } } } },
        },
      },
    },
  });

  // Every payment that touched one of those challans, with ALL its allocations —
  // a payment spread across several months is the hard case for moving money.
  const paymentIds = [...new Set(challans.flatMap((c) => c.allocations.map((a) => a.paymentId)))];
  const payments = await prisma.feePayment.findMany({
    where: { id: { in: paymentIds } },
    orderBy: { paymentDate: 'asc' },
    include: {
      receivedBy: { select: { fullName: true } },
      reversedBy: { select: { fullName: true } },
      allocations: { include: { challan: { select: { id: true, challanNo: true, year: true, month: true } } } },
    },
  });

  // ---- Salary slips that deducted staff fees -------------------------------
  const riderTeacherIds = routes.flatMap((r) => r.assignments.map((a) => a.teacherId)).filter((x): x is string => !!x);
  const slips = await prisma.salarySlip.findMany({
    where: { OR: [{ staffFeeDeduction: { gt: 0 } }, { teacherId: { in: riderTeacherIds } }] },
    orderBy: [{ year: 'asc' }, { month: 'asc' }],
    include: {
      teacher: {
        select: {
          id: true, employeeId: true, user: { select: { fullName: true } },
          transportAssignment: { select: { route: { select: { id: true, name: true, staffMonthlyFee: true } } } },
        },
      },
    },
  });
  // The slip stores one blended deduction. Its transport share is whatever the
  // children's challans did not absorb — the same split the slip detail shows.
  const slipRows = [];
  for (const s of slips) {
    const childChallans = await prisma.feeChallan.findMany({
      where: { billedToTeacherId: s.teacherId, year: s.year, month: s.month },
      select: { id: true, challanNo: true, staffCovered: true, items: { select: { type: true, label: true, amount: true } } },
    });
    const childrenCovered = sum(childChallans.map((c) => c.staffCovered));
    const ownTransportDeducted = round2(money(s.staffFeeDeduction).minus(childrenCovered));
    slipRows.push({
      slip: s,
      childChallans,
      childrenCovered: toMoneyString(childrenCovered),
      ownTransportDeducted: toMoneyString(ownTransportDeducted.lessThan(0) ? ZERO : ownTransportDeducted),
    });
  }

  // ---- Student riders' own fee challans ------------------------------------
  // "Skip students who use transport" gave a rider NO challan at all, tuition
  // included, so a rider can be missing whole months that everyone else was
  // billed for. The months anyone was billed are the yardstick.
  const riderStudentIds = routes.flatMap((r) => r.assignments.map((a) => a.studentId)).filter((x): x is string => !!x);
  const billedPeriods = await prisma.feeChallan.groupBy({ by: ['year', 'month'], _count: { _all: true }, orderBy: [{ year: 'asc' }, { month: 'asc' }] });
  const riderChallans = await prisma.feeChallan.findMany({
    where: { studentId: { in: riderStudentIds } },
    orderBy: [{ year: 'asc' }, { month: 'asc' }],
    select: {
      id: true, challanNo: true, studentId: true, year: true, month: true, status: true, amount: true,
      items: { select: { type: true, label: true, amount: true } },
    },
  });
  const riderCoverage = routes.flatMap((r) =>
    r.assignments
      .filter((a) => a.student)
      .map((a) => {
        const own = riderChallans.filter((c) => c.studentId === a.studentId);
        const have = new Set(own.map((c) => period(c.year, c.month)));
        return {
          route: r.name,
          student: a.student!,
          assignedAt: a.createdAt,
          challans: own,
          missingPeriods: billedPeriods.map((p) => period(p.year, p.month)).filter((p) => !have.has(p)),
        };
      }),
  );

  // Generation runs, with the options they were run with — which ones held riders back.
  const generationRuns = await prisma.auditLog.findMany({
    where: { module: 'FEES', action: 'CREATE', targetType: 'FeeChallan' },
    orderBy: { timestamp: 'asc' },
    select: { id: true, timestamp: true, actorName: true, targetLabel: true, details: true, changes: true },
  });

  // ---- Classify each transport-bearing challan -----------------------------
  type Bucket = 'untouched' | 'part-settled' | 'settled' | 'waived';
  const challanRows = challans.map((c) => {
    const ledger = paidBreakdown(c);
    const transport = sum(c.items.filter((i) => i.type === FeeItemType.TRANSPORT).map((i) => i.amount));
    const settledAny = ledger.cash.greaterThan(0) || ledger.staff.greaterThan(0);
    const bucket: Bucket =
      c.status === 'WAIVED' ? 'waived' : ledger.balance.lessThanOrEqualTo(0) ? 'settled' : settledAny ? 'part-settled' : 'untouched';
    const multiMonthPayments = c.allocations
      .map((a) => payments.find((p) => p.id === a.paymentId))
      .filter((p) => p && p.allocations.length > 1).length;
    return {
      period: period(c.year, c.month),
      bucket,
      transport: toMoneyString(transport),
      cashPaid: toMoneyString(ledger.cash),
      staffCovered: toMoneyString(ledger.staff),
      balance: toMoneyString(ledger.balance),
      hasDiscount: money(c.discount).greaterThan(0),
      hasLateFee: money(c.lateFee).greaterThan(0),
      staffBilled: !!c.billedToTeacherId,
      onlyTransport: c.items.every((i) => i.type === FeeItemType.TRANSPORT),
      multiMonthPayments,
      challan: c,
    };
  });

  // ---- Write the backup ----------------------------------------------------
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(__dirname, '..', `_transport_backup_${stamp}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note: 'Read-only snapshot taken before moving transport out of fee challans and salary slips.',
        routes,
        feeChallansWithTransport: challanRows,
        paymentsTouchingThoseChallans: payments,
        salarySlips: slipRows,
        studentRiderFeeChallans: riderCoverage,
        challanGenerationRuns: generationRuns,
      },
      null,
      2,
    ),
  );

  // ---- Summary -------------------------------------------------------------
  const riders = routes.flatMap((r) => r.assignments);
  console.log('\n=== ROUTES ===');
  for (const r of routes) {
    const st = r.assignments.filter((a) => a.studentId).length;
    const sf = r.assignments.filter((a) => a.teacherId).length;
    console.log(
      `  ${r.active ? ' ' : 'x'} ${r.name.padEnd(28)} student ${String(r.studentMonthlyFee ?? '—').padStart(8)}  staff ${String(r.staffMonthlyFee ?? '—').padStart(8)}  riders: ${st} students, ${sf} staff`,
    );
  }
  console.log(`  total riders: ${riders.filter((a) => a.studentId).length} students (${riders.filter((a) => a.student?.teacherParentId).length} staff children), ${riders.filter((a) => a.teacherId).length} staff`);

  console.log('\n=== FEE CHALLANS WITH A TRANSPORT LINE ===');
  const byPeriod = new Map<string, typeof challanRows>();
  for (const row of challanRows) byPeriod.set(row.period, [...(byPeriod.get(row.period) ?? []), row]);
  for (const [p, rows] of byPeriod) {
    const [y, m] = p.split('-').map(Number);
    const count = (b: Bucket) => rows.filter((r) => r.bucket === b).length;
    console.log(
      `  ${MONTHS[m]} ${y}: ${rows.length} challans, transport Rs ${toMoneyString(sum(rows.map((r) => r.transport)))} | ` +
        `untouched ${count('untouched')}, part-settled ${count('part-settled')}, settled ${count('settled')}, waived ${count('waived')} | ` +
        `staff-billed ${rows.filter((r) => r.staffBilled).length}, discounted ${rows.filter((r) => r.hasDiscount).length}, ` +
        `late fee ${rows.filter((r) => r.hasLateFee).length}, transport-only ${rows.filter((r) => r.onlyTransport).length}, ` +
        `paid by a multi-month payment ${rows.filter((r) => r.multiMonthPayments > 0).length}`,
    );
  }
  console.log(`  total: ${challanRows.length} challans, ${payments.length} payments touch them (${payments.filter((p) => p.isReversed).length} reversed)`);

  console.log('\n=== SALARY SLIPS ===');
  const withOwn = slipRows.filter((s) => money(s.ownTransportDeducted).greaterThan(0));
  for (const s of withOwn) {
    console.log(
      `  ${MONTHS[s.slip.month]} ${s.slip.year}  ${s.slip.teacher.employeeId.padEnd(10)} ${s.slip.teacher.user.fullName.padEnd(24)} ` +
        `own transport Rs ${s.ownTransportDeducted.padStart(8)}  children Rs ${s.childrenCovered.padStart(8)}  slip ${s.slip.status}`,
    );
  }
  console.log(`  slips deducting own transport: ${withOwn.length} (${withOwn.filter((s) => s.slip.status === 'PAID').length} paid)`);
  console.log(`  slips with any staff-fee deduction: ${slipRows.filter((s) => money(s.slip.staffFeeDeduction).greaterThan(0)).length}`);

  console.log('\n=== STUDENT RIDERS: FEE CHALLAN COVERAGE ===');
  console.log(`  months anyone was billed: ${billedPeriods.map((p) => `${MONTHS[p.month]} ${p.year} (${p._count._all})`).join(', ')}`);
  for (const r of riderCoverage) {
    const s = r.student;
    const months = r.challans.map((c) => `${MONTHS[c.month]}:${c.status}`).join(' ') || 'none';
    console.log(
      `  ${s.admissionNo.padEnd(9)} ${`${s.firstName} ${s.lastName}`.padEnd(26)} ${r.route.padEnd(18)} ` +
        `assigned ${r.assignedAt.toISOString().slice(0, 10)} | challans: ${months.padEnd(30)} | missing: ${r.missingPeriods.join(', ') || '—'}`,
    );
  }

  console.log('\n=== CHALLAN GENERATION RUNS ===');
  for (const g of generationRuns) {
    const meta = (g.changes as { _meta?: { options?: { excludeTransportRiders?: boolean }; ridersExcluded?: number; studentCount?: number; scope?: string } } | null)?._meta;
    console.log(
      `  ${g.timestamp.toISOString().slice(0, 16)} ${g.actorName.padEnd(20)} ${g.targetLabel.padEnd(36)} ` +
        `created ${String(meta?.studentCount ?? '?').padStart(4)} | riders held back: ${meta?.options?.excludeTransportRiders ? `YES (${meta.ridersExcluded})` : 'no'} | ${meta?.scope ?? ''}`,
    );
  }

  console.log(`\nBackup written: ${file}\n`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
