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
 * Why generate-then-swap rather than writing challans directly: challan
 * numbering, the per-student uniqueness guard and status derivation all live in
 * the fee service, and reimplementing them here would mean two definitions of a
 * challan that could drift. So the rows are created by the real service, then
 * the tuition line is exchanged for the arrears line in one transaction.
 *
 *   npx tsx scripts/import-opening-balances.ts          # dry run, writes nothing
 *   npx tsx scripts/import-opening-balances.ts --apply
 */
import fs from 'fs';
import path from 'path';
import { Prisma, UserStatus, FeeItemType } from '@prisma/client';
import { prisma } from '../src/config/prisma';
import { generateChallans, recomputeChallan } from '../src/modules/fees/fees.service';
import { logAudit } from '../src/modules/audit/audit.service';

const APPLY = process.argv.includes('--apply');
const SHEET = process.env.SHEET_TSV ?? path.resolve(__dirname, '../_opening_balances.tsv');

const YEAR = 2026;
const MONTH = 8;
const DUE_DATE = '2026-08-22';
const ARREARS_LABEL = 'Arrears as at 01-08-2026';

/** The sheet's own totals. If we don't hit these exactly, we don't write. */
const EXPECT_STUDENTS = 213;
const EXPECT_TOTAL = 690_100;

const money = (n: number) => new Prisma.Decimal(n.toFixed(2));
const pkr = (n: number | Prisma.Decimal) => `Rs ${Number(n).toLocaleString('en-PK')}`;

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
  const students = await prisma.student.findMany({
    where: { admissionNo: { in: rows.map((r) => r.admissionNo) } },
    select: {
      id: true, admissionNo: true, firstName: true, lastName: true, status: true,
      section: { select: { name: true, class: { select: { name: true, order: true } } } },
    },
  });
  const byAdm = new Map(students.map((s) => [s.admissionNo, s]));

  const plan: { id: string; admissionNo: string; name: string; className: string; order: number; balance: number }[] = [];
  const missing: string[] = [];
  const inactive: { admissionNo: string; name: string; balance: number }[] = [];

  for (const r of rows) {
    const s = byAdm.get(r.admissionNo);
    if (!s) {
      missing.push(`${r.admissionNo} (${r.sheetName})`);
      continue;
    }
    // Inactive students are excluded by design — every deactivation was
    // confirmed deliberate, and billing someone who has left creates a
    // defaulter that can never be cleared.
    if (s.status !== UserStatus.ACTIVE) {
      inactive.push({ admissionNo: s.admissionNo, name: `${s.firstName} ${s.lastName ?? ''}`.trim(), balance: r.balance });
      continue;
    }
    plan.push({
      id: s.id,
      admissionNo: s.admissionNo,
      name: `${s.firstName} ${s.lastName ?? ''}`.trim(),
      className: s.section.class.name,
      order: s.section.class.order,
      balance: r.balance,
    });
  }

  // ---- 3. Reconcile before touching anything -------------------------------
  const total = plan.reduce((a, p) => a + p.balance, 0);
  const byClass = new Map<string, { order: number; n: number; total: number }>();
  for (const p of plan) {
    const e = byClass.get(p.className) ?? { order: p.order, n: 0, total: 0 };
    e.n++; e.total += p.balance;
    byClass.set(p.className, e);
  }

  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — opening balances, August ${YEAR}, due ${DUE_DATE}\n`);
  console.log('  class            students        arrears');
  for (const [name, e] of [...byClass.entries()].sort((a, b) => a[1].order - b[1].order)) {
    console.log(`  ${name.padEnd(14)} ${String(e.n).padStart(8)}   ${pkr(e.total).padStart(12)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(14)} ${String(plan.length).padStart(8)}   ${pkr(total).padStart(12)}\n`);

  if (missing.length) console.log(`  not found in the database (${missing.length}): ${missing.join(', ')}`);
  if (inactive.length) {
    console.log(`  skipped, inactive (${inactive.length}, ${pkr(inactive.reduce((a, i) => a + i.balance, 0))}):`);
    for (const i of inactive) console.log(`     ${i.admissionNo}  ${i.name} — ${pkr(i.balance)}`);
  }

  if (plan.length !== EXPECT_STUDENTS || total !== EXPECT_TOTAL) {
    throw new Error(
      `Reconciliation failed — expected ${EXPECT_STUDENTS} students / ${pkr(EXPECT_TOTAL)}, ` +
        `got ${plan.length} / ${pkr(total)}. Nothing was written.`,
    );
  }
  console.log(`  reconciled against the sheet: ${EXPECT_STUDENTS} students, ${pkr(EXPECT_TOTAL)}\n`);

  // ---- 4. Pre-flight: refuse to run into existing data ---------------------
  const existing = await prisma.feeChallan.count({ where: { year: YEAR, month: MONTH, studentId: { in: plan.map((p) => p.id) } } });
  if (existing > 0) {
    console.log(`  NOTE: ${existing} of these students already have an Aug ${YEAR} challan; generation skips them.`);
  }
  const credit = await prisma.feePayment.count({ where: { isReversed: false, studentId: { in: plan.map((p) => p.id) } } });
  if (credit > 0) {
    throw new Error(`${credit} payment(s) exist for these students — they would be auto-applied to the new challans. Review the Payments tab first.`);
  }

  if (!APPLY) {
    console.log('  Dry run only. Re-run with --apply to write.\n');
    return;
  }

  // ---- 5. Create the challans through the real service ---------------------
  const superadmin = await prisma.user.findFirst({ where: { role: 'SUPERADMIN' }, select: { id: true, role: true } });
  if (!superadmin) throw new Error('No SUPERADMIN user to attribute the import to.');
  const actor = { userId: superadmin.id, role: superadmin.role };

  // Chunked deliberately. generateChallans runs every student inside ONE
  // interactive transaction, and at ~6 queries per student against a database
  // 270ms away, 213 students needs ~345s — past its own 120s ceiling, so a
  // single call always aborts. Each chunk is its own transaction and commits
  // independently; generation already skips a student who has a challan for
  // the period, so a re-run after a failure resumes rather than duplicates.
  const CHUNK = 25;
  let created = 0;
  for (let i = 0; i < plan.length; i += CHUNK) {
    const batch = plan.slice(i, i + CHUNK);
    const gen = await generateChallans(actor, {
      year: YEAR,
      month: MONTH,
      dueDate: DUE_DATE,
      studentIds: batch.map((p) => p.id),
    } as Parameters<typeof generateChallans>[1]);
    created += gen.created;
    console.log(`    generated ${String(Math.min(i + CHUNK, plan.length)).padStart(3)}/${plan.length}  (+${gen.created}, skipped ${gen.skipped})`);
  }
  console.log(`  created ${created} challan(s)`);

  // ---- 6. Swap the tuition line for the arrears line -----------------------
  const balanceOf = new Map(plan.map((p) => [p.id, p.balance]));
  const challans = await prisma.feeChallan.findMany({
    where: { year: YEAR, month: MONTH, studentId: { in: plan.map((p) => p.id) } },
    include: { items: true },
  });

  let swapped = 0;
  let alreadyDone = 0;
  // Chunked for the same latency reason, and batched within each chunk: the
  // delete and the insert are one query each for the whole chunk rather than
  // two per challan.
  for (let i = 0; i < challans.length; i += CHUNK) {
    const batch = challans.slice(i, i + CHUNK);
    // Idempotent: a challan already carrying the arrears line is left exactly
    // as it is, so a re-run can never stack a second one.
    const todo = batch.filter((c) => !c.items.some((it) => it.label === ARREARS_LABEL) && balanceOf.has(c.studentId));
    alreadyDone += batch.length - todo.length;
    if (todo.length === 0) continue;

    await prisma.$transaction(
      async (tx) => {
        const ids = todo.map((c) => c.id);
        await tx.feeChallanItem.deleteMany({ where: { challanId: { in: ids }, type: FeeItemType.TUITION } });
        await tx.feeChallanItem.createMany({
          data: todo.map((c) => ({
            challanId: c.id,
            type: FeeItemType.OTHER,
            label: ARREARS_LABEL,
            amount: money(balanceOf.get(c.studentId) as number),
          })),
        });

        // Mirrors patchChallan's arithmetic: payable = items − discount + lateFee.
        // Items are re-read from the database rather than assumed, so anything
        // unexpected already on the challan is still counted.
        const items = await tx.feeChallanItem.findMany({ where: { challanId: { in: ids } } });
        const byChallan = new Map<string, Prisma.Decimal>();
        for (const it of items) byChallan.set(it.challanId, (byChallan.get(it.challanId) ?? new Prisma.Decimal(0)).plus(it.amount));

        for (const c of todo) {
          const base = byChallan.get(c.id) ?? new Prisma.Decimal(0);
          const discount = Prisma.Decimal.min(c.discount, base);
          await tx.feeChallan.update({
            where: { id: c.id },
            data: { baseAmount: base, discount, amount: base.minus(discount).plus(c.lateFee) },
          });
          await recomputeChallan(tx, c.id);
          swapped++;
        }
      },
      { timeout: 120_000, maxWait: 20_000 },
    );
    console.log(`    arrears  ${String(Math.min(i + CHUNK, challans.length)).padStart(3)}/${challans.length}`);
  }
  console.log(`  arrears line applied to ${swapped} challan(s)${alreadyDone ? `, ${alreadyDone} already had one` : ''}`);

  // ---- 7. One audit entry for the whole import ----------------------------
  await logAudit(null, {
    actorId: actor.userId,
    action: 'CREATE',
    module: 'FEES',
    targetType: 'FeeChallan',
    targetLabel: `Opening balances — ${swapped} challans · ${pkr(total)}`,
    details:
      `Imported opening fee balances from the printed "List of Overall Balances" dated 01-08-2026. ` +
      `Created ${swapped} challan(s) for August ${YEAR} totalling ${pkr(total)}, each carrying a single ` +
      `"${ARREARS_LABEL}" line. August tuition was deliberately NOT charged: the sheet states what was ` +
      `owed as at 1 August, so billing that month again would double-charge it. ` +
      `${inactive.length} inactive student(s) holding ${pkr(inactive.reduce((a, i) => a + i.balance, 0))} were excluded.`,
    changes: { _meta: { source: 'List of Overall Balances 01-08-2026', students: swapped, total: String(total), period: `${YEAR}-${MONTH}`, dueDate: DUE_DATE } },
  });

  // ---- 8. Verify what actually landed --------------------------------------
  const after = await prisma.feeChallan.findMany({
    where: { year: YEAR, month: MONTH, studentId: { in: plan.map((p) => p.id) } },
    include: { items: true, student: { select: { admissionNo: true, section: { select: { class: { select: { name: true, order: true } } } } } } },
  });
  const wrote = after.reduce((a, c) => a + Number(c.amount), 0);
  const stray = after.filter((c) => c.items.some((i) => i.type !== FeeItemType.OTHER));
  const mismatched = after.filter((c) => Number(c.amount) !== balanceOf.get(c.studentId));

  console.log('\n  VERIFICATION');
  console.log(`    challans written : ${after.length} (expected ${EXPECT_STUDENTS})`);
  console.log(`    total billed     : ${pkr(wrote)} (expected ${pkr(EXPECT_TOTAL)})`);
  console.log(`    non-arrears lines: ${stray.length} (expected 0)`);
  console.log(`    amount mismatches: ${mismatched.length} (expected 0)`);
  for (const m of mismatched.slice(0, 10)) {
    console.log(`       ${m.student.admissionNo}: challan ${pkr(m.amount)} vs sheet ${pkr(balanceOf.get(m.studentId) ?? 0)}`);
  }
  const ok = after.length === EXPECT_STUDENTS && wrote === EXPECT_TOTAL && stray.length === 0 && mismatched.length === 0;
  console.log(`\n  ${ok ? 'OK — the import matches the sheet exactly.' : 'MISMATCH — review before relying on these figures.'}\n`);
}

main()
  .catch((e) => { console.error('\nFAILED:', e.message, '\n'); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
