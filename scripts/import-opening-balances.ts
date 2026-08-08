/**
 * One-off import of the school's opening fee balances.
 *
 * Source: "List of Overall Balances" dated 01-08-2026, transcribed from the
 * printed sheet and reconciled against its own per-class subtotals (222
 * students / Rs 741,200 — every class and the grand total agree).
 *
 * What it produces: ONE challan per student for August 2026 carrying a single
 * `OTHER` line for what they already owed. Deliberately NO August tuition —
 * the sheet is a statement of arrears as at 1 August, so billing August's own
 * fee on top would double-charge the month the sheet was drawn.
 *
 * Inactive students are included. `generateChallans` hard-filters to ACTIVE, so
 * it cannot be used here at all; challans are created directly instead. That is
 * safe for this data specifically because none of these students has a fee
 * discount, a transport assignment or a teacher-parent, so the only line a
 * generated challan would have carried is the tuition one we are replacing.
 *
 * Every write is CONVERGENT: each challan is rewritten to exactly one arrears
 * line for the sheet figure, whatever it currently holds. Run it once or five
 * times and the result is identical.
 *
 *   npx tsx scripts/import-opening-balances.ts          # dry run, writes nothing
 *   npx tsx scripts/import-opening-balances.ts --apply
 */
import fs from 'fs';
import path from 'path';
import { Prisma, UserStatus, FeeItemType, ChallanStatus } from '@prisma/client';
import { prisma } from '../src/config/prisma';
import { recomputeChallan } from '../src/modules/fees/fees.service';
import { logAudit } from '../src/modules/audit/audit.service';

const APPLY = process.argv.includes('--apply');
const SHEET = process.env.SHEET_TSV ?? path.resolve(__dirname, '../_opening_balances.tsv');

const YEAR = 2026;
const MONTH = 8;
const DUE_DATE = new Date('2026-08-22T00:00:00.000Z');
const ARREARS_LABEL = 'Arrears as at 01-08-2026';
const CHUNK = 25;

/** The sheet's own totals. If we don't hit these exactly, we don't write. */
const EXPECT_STUDENTS = 222;
const EXPECT_TOTAL = 741_200;

const money = (n: number) => new Prisma.Decimal(n.toFixed(2));
const pkr = (n: number | Prisma.Decimal) => `Rs ${Number(n).toLocaleString('en-PK')}`;

/** Same counter and format the fee service uses, so numbering never collides. */
async function nextChallanNo(tx: Prisma.TransactionClient, year: number) {
  const counter = await tx.challanCounter.upsert({
    where: { year },
    create: { year, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
  });
  return `CH-${year}-${String(counter.lastNumber).padStart(6, '0')}`;
}

async function main() {
  // ---- 1. Read the sheet ---------------------------------------------------
  const rows = fs
    .readFileSync(SHEET, 'utf-8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.split('\t'))
    .map((c) => ({ admissionNo: `STD-${c[1].trim()}`, sheetName: c[2].trim(), balance: Number(c[7]) }))
    .filter((r) => r.balance > 0);

  // ---- 2. Resolve against the database ------------------------------------
  // No status filter: inactive students are billed too, by explicit decision.
  // Their arrears are a real debt and stay on record even though they left.
  const students = await prisma.student.findMany({
    where: { admissionNo: { in: rows.map((r) => r.admissionNo) } },
    select: {
      id: true, admissionNo: true, firstName: true, lastName: true, status: true, feeDiscount: true,
      teacherParentId: true,
      section: { select: { class: { select: { name: true, order: true } } } },
    },
  });
  const byAdm = new Map(students.map((s) => [s.admissionNo, s]));

  const plan: {
    id: string; admissionNo: string; name: string; className: string; order: number;
    balance: number; status: UserStatus;
  }[] = [];
  const missing: string[] = [];

  for (const r of rows) {
    const s = byAdm.get(r.admissionNo);
    if (!s) {
      missing.push(`${r.admissionNo} (${r.sheetName})`);
      continue;
    }
    plan.push({
      id: s.id,
      admissionNo: s.admissionNo,
      name: `${s.firstName} ${s.lastName ?? ''}`.trim(),
      className: s.section.class.name,
      order: s.section.class.order,
      balance: r.balance,
      status: s.status,
    });
  }

  // ---- 3. Reconcile before touching anything -------------------------------
  const total = plan.reduce((a, p) => a + p.balance, 0);
  const inactive = plan.filter((p) => p.status !== UserStatus.ACTIVE);
  const byClass = new Map<string, { order: number; n: number; total: number }>();
  for (const p of plan) {
    const e = byClass.get(p.className) ?? { order: p.order, n: 0, total: 0 };
    e.n++; e.total += p.balance;
    byClass.set(p.className, e);
  }

  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — opening balances, August ${YEAR}, due ${DUE_DATE.toISOString().slice(0, 10)}\n`);
  console.log('  class            students        arrears');
  for (const [name, e] of [...byClass.entries()].sort((a, b) => a[1].order - b[1].order)) {
    console.log(`  ${name.padEnd(14)} ${String(e.n).padStart(8)}   ${pkr(e.total).padStart(12)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(14)} ${String(plan.length).padStart(8)}   ${pkr(total).padStart(12)}\n`);

  if (missing.length) console.log(`  not found in the database (${missing.length}): ${missing.join(', ')}`);
  console.log(`  included despite being inactive (${inactive.length}, ${pkr(inactive.reduce((a, i) => a + i.balance, 0))}):`);
  for (const i of inactive) console.log(`     ${i.admissionNo}  ${i.name} — ${pkr(i.balance)}`);
  console.log();

  if (plan.length !== EXPECT_STUDENTS || total !== EXPECT_TOTAL) {
    throw new Error(
      `Reconciliation failed — expected ${EXPECT_STUDENTS} students / ${pkr(EXPECT_TOTAL)}, ` +
        `got ${plan.length} / ${pkr(total)}. Nothing was written.`,
    );
  }
  console.log(`  reconciled against the sheet: ${EXPECT_STUDENTS} students, ${pkr(EXPECT_TOTAL)}`);

  // ---- 4. Pre-flight -------------------------------------------------------
  // Direct creation skips the fee service, so re-assert here what the service
  // would otherwise have handled: anything that would add a second line to a
  // challan, or money that a wholesale item rewrite would contradict.
  const complicated = plan.filter((p) => {
    const s = byAdm.get(p.admissionNo);
    return Number(s?.feeDiscount ?? 0) > 0 || s?.teacherParentId;
  });
  if (complicated.length > 0) {
    throw new Error(`${complicated.length} student(s) have a fee discount or a teacher-parent; this script does not model either.`);
  }
  const riders = await prisma.transportAssignment.count({ where: { studentId: { in: plan.map((p) => p.id) } } });
  if (riders > 0) throw new Error(`${riders} of these students have a transport assignment; their challan needs a transport line.`);

  const existing = await prisma.feeChallan.findMany({
    where: { year: YEAR, month: MONTH, studentId: { in: plan.map((p) => p.id) } },
    include: { items: true },
  });
  const allocated = await prisma.feePaymentAllocation.count({ where: { challanId: { in: existing.map((c) => c.id) } } });
  const covered = existing.filter((c) => Number(c.staffCovered) > 0);
  if (allocated > 0 || covered.length > 0) {
    throw new Error(`${allocated} allocation(s) and ${covered.length} staff-covered challan(s) exist. Resolve those before running.`);
  }

  const byStudent = new Map(existing.map((c) => [c.studentId, c]));
  const toCreate = plan.filter((p) => !byStudent.has(p.id));
  const toRewrite = plan.filter((p) => byStudent.has(p.id));
  console.log(`  ${toCreate.length} challan(s) to create, ${toRewrite.length} to rewrite to the sheet figure\n`);

  if (!APPLY) {
    console.log('  Dry run only. Re-run with --apply to write.\n');
    return;
  }

  // ---- 5. Create the missing challans --------------------------------------
  let created = 0;
  for (let i = 0; i < toCreate.length; i += CHUNK) {
    const batch = toCreate.slice(i, i + CHUNK);
    await prisma.$transaction(
      async (tx) => {
        for (const p of batch) {
          const amount = money(p.balance);
          await tx.feeChallan.create({
            data: {
              challanNo: await nextChallanNo(tx, YEAR),
              studentId: p.id,
              year: YEAR,
              month: MONTH,
              baseAmount: amount,
              discount: new Prisma.Decimal(0),
              amount,
              dueDate: DUE_DATE,
              status: ChallanStatus.UNPAID,
              items: { create: [{ type: FeeItemType.OTHER, label: ARREARS_LABEL, amount }] },
            },
          });
          created++;
        }
      },
      { timeout: 120_000, maxWait: 20_000 },
    );
    console.log(`    created  ${String(Math.min(i + CHUNK, toCreate.length)).padStart(3)}/${toCreate.length}`);
  }

  // ---- 6. Rewrite the existing ones to exactly one arrears line -------------
  let rewritten = 0;
  for (let i = 0; i < toRewrite.length; i += CHUNK) {
    const batch = toRewrite.slice(i, i + CHUNK);
    await prisma.$transaction(
      async (tx) => {
        const ids = batch.map((p) => byStudent.get(p.id)!.id);
        // Clear everything, then write the one line that should be there. This
        // is what makes the step idempotent by construction rather than by
        // checking first — a check reads a snapshot that goes stale the moment
        // the phase runs twice, which previously duplicated 63 arrears lines.
        await tx.feeChallanItem.deleteMany({ where: { challanId: { in: ids } } });
        await tx.feeChallanItem.createMany({
          data: batch.map((p) => ({
            challanId: byStudent.get(p.id)!.id,
            type: FeeItemType.OTHER,
            label: ARREARS_LABEL,
            amount: money(p.balance),
          })),
        });

        // Mirrors patchChallan's arithmetic: payable = items − discount + lateFee.
        for (const p of batch) {
          const c = byStudent.get(p.id)!;
          const base = money(p.balance);
          const discount = Prisma.Decimal.min(c.discount, base);
          await tx.feeChallan.update({
            where: { id: c.id },
            data: { baseAmount: base, discount, amount: base.minus(discount).plus(c.lateFee) },
          });
          await recomputeChallan(tx, c.id);
          rewritten++;
        }
      },
      { timeout: 120_000, maxWait: 20_000 },
    );
    console.log(`    rewrote  ${String(Math.min(i + CHUNK, toRewrite.length)).padStart(3)}/${toRewrite.length}`);
  }
  console.log(`  ${created} created, ${rewritten} rewritten`);

  // ---- 7. One audit entry for the whole import ----------------------------
  await logAudit(null, {
    actorId: (await prisma.user.findFirstOrThrow({ where: { role: 'SUPERADMIN' }, select: { id: true } })).id,
    action: 'CREATE',
    module: 'FEES',
    targetType: 'FeeChallan',
    targetLabel: `Opening balances — ${plan.length} challans · ${pkr(total)}`,
    details:
      `Imported opening fee balances from the printed "List of Overall Balances" dated 01-08-2026. ` +
      `${created} challan(s) created and ${rewritten} rewritten for August ${YEAR}, totalling ${pkr(total)}, ` +
      `each carrying a single "${ARREARS_LABEL}" line. August tuition was deliberately NOT charged: the sheet ` +
      `states what was owed as at 1 August, so billing that month again would double-charge it. ` +
      `${inactive.length} inactive student(s) holding ${pkr(inactive.reduce((a, i) => a + i.balance, 0))} were ` +
      `included by explicit decision — note the Fee Defaulters report only lists active students, so their ` +
      `arrears will not appear there.`,
    changes: { _meta: { source: 'List of Overall Balances 01-08-2026', created, rewritten, total: String(total), period: `${YEAR}-${MONTH}`, inactiveIncluded: inactive.map((i) => i.admissionNo) } },
  });

  // ---- 8. Verify what actually landed --------------------------------------
  const balanceOf = new Map(plan.map((p) => [p.id, p.balance]));
  const after = await prisma.feeChallan.findMany({
    where: { year: YEAR, month: MONTH, studentId: { in: plan.map((p) => p.id) } },
    include: { items: true, student: { select: { admissionNo: true } } },
  });
  const wrote = after.reduce((a, c) => a + Number(c.amount), 0);
  const itemsTotal = after.reduce((a, c) => a + c.items.reduce((b, i) => b + Number(i.amount), 0), 0);
  const stray = after.filter((c) => c.items.some((i) => i.type !== FeeItemType.OTHER));
  const mismatched = after.filter((c) => Number(c.amount) !== balanceOf.get(c.studentId));
  // A challan must carry exactly ONE line. Totals alone would not have caught
  // the duplicated arrears line that this check exists for.
  const wrongLineCount = after.filter((c) => c.items.length !== 1);

  console.log('\n  VERIFICATION');
  console.log(`    challans written  : ${after.length} (expected ${EXPECT_STUDENTS})`);
  console.log(`    total billed      : ${pkr(wrote)} (expected ${pkr(EXPECT_TOTAL)})`);
  console.log(`    line items total  : ${pkr(itemsTotal)} (expected ${pkr(EXPECT_TOTAL)})`);
  console.log(`    non-arrears lines : ${stray.length} (expected 0)`);
  console.log(`    wrong line count  : ${wrongLineCount.length} (expected 0)`);
  console.log(`    amount mismatches : ${mismatched.length} (expected 0)`);
  for (const m of mismatched.slice(0, 10)) {
    console.log(`       ${m.student.admissionNo}: challan ${pkr(m.amount)} vs sheet ${pkr(balanceOf.get(m.studentId) ?? 0)}`);
  }
  for (const w of wrongLineCount.slice(0, 10)) {
    console.log(`       ${w.student.admissionNo}: ${w.items.length} line items (expected 1)`);
  }
  const ok =
    after.length === EXPECT_STUDENTS && wrote === EXPECT_TOTAL && itemsTotal === EXPECT_TOTAL &&
    stray.length === 0 && mismatched.length === 0 && wrongLineCount.length === 0;
  console.log(`\n  ${ok ? 'OK — the import matches the sheet exactly.' : 'MISMATCH — review before relying on these figures.'}\n`);
}

main()
  .catch((e) => { console.error('\nFAILED:', e.message, '\n'); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
