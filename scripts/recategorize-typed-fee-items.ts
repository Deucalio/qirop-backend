/**
 * One-off: file hand-typed "Other" fee-challan lines under their real category.
 *
 * Until November 2026 the challan screen's "Add an item" box saved every
 * charge as OTHER with whatever text was typed, so transport ("transpot",
 * "tranpot"), admission ("Admetion") and month-fee corrections ("June",
 * "Month fess difference") all landed in the reports' "Exam & Other" line.
 * The box now asks for a category; this fixes the lines added before that.
 *
 * Only the item's TYPE changes. Amounts, payments, balances and challan
 * statuses are untouched — the challan total is the same sum of the same
 * numbers. Opening-balance arrears ("Arrears as at …") are left alone, and so
 * are lines whose text is ambiguous (e.g. "Monthlay and transpout", "Old"):
 * they stay OTHER and keep showing as "Other (typed by hand)".
 *
 * Safe to re-run: a line is changed only while it is still OTHER with the
 * same text it had when read. Before writing, every affected line is saved to
 * `_fee_item_recategorize_backup_<timestamp>.json` (gitignored: real names)
 * and the change is recorded on the History page.
 *
 *   npx tsx scripts/recategorize-typed-fee-items.ts           # dry run: lists what would change
 *   npx tsx scripts/recategorize-typed-fee-items.ts --apply   # backs up, then changes
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { FeeItemType } from '@prisma/client';
import { prisma } from '../src/config/prisma';
import { logAudit } from '../src/modules/audit/audit.service';

const APPLY = process.argv.includes('--apply');

/** What the typed text means. Null leaves the line as OTHER. */
function categoryOf(label: string): FeeItemType | null {
  const l = label.toLowerCase().replace(/\s+/g, ' ').trim();
  const transport = /tra?n?s?p(o|ou)?r?t|tranpot|transpot|transpout/.test(l);
  const tuition = /month|june|jula|july|fee|fess|difant|difran|differ/.test(l);
  if (transport && tuition) return null; // both in one line — the split is unknown
  if (transport) return FeeItemType.TRANSPORT;
  if (/adm/.test(l)) return FeeItemType.ADMISSION;
  if (tuition) return FeeItemType.TUITION;
  return null; // e.g. "Old" — not enough to go on
}

async function main() {
  const items = await prisma.feeChallanItem.findMany({
    where: { type: FeeItemType.OTHER, NOT: { label: { startsWith: 'Arrears as at ' } } },
    include: {
      challan: { select: { challanNo: true, year: true, month: true, student: { select: { firstName: true, lastName: true, admissionNo: true } } } },
    },
    orderBy: [{ challan: { year: 'asc' } }, { challan: { month: 'asc' } }],
  });

  const plan = items.map((i) => ({
    itemId: i.id,
    challanId: i.challanId,
    challanNo: i.challan.challanNo,
    billMonth: `${i.challan.year}-${String(i.challan.month).padStart(2, '0')}`,
    student: `${i.challan.student.firstName}${i.challan.student.lastName ? ` ${i.challan.student.lastName}` : ''} (${i.challan.student.admissionNo})`,
    label: i.label,
    amount: String(i.amount),
    from: i.type,
    to: categoryOf(i.label),
  }));
  const changes = plan.filter((p): p is typeof p & { to: FeeItemType } => p.to !== null);
  const kept = plan.filter((p) => p.to === null);

  const tally: Record<string, { lines: number; amount: number }> = {};
  for (const c of changes) {
    tally[c.to] ??= { lines: 0, amount: 0 };
    tally[c.to].lines++;
    tally[c.to].amount += Number(c.amount);
  }
  console.log(`${plan.length} hand-typed OTHER lines. ${changes.length} to re-file, ${kept.length} left as OTHER.`);
  for (const [to, t] of Object.entries(tally)) console.log(`  → ${to}: ${t.lines} lines, Rs ${t.amount}`);
  for (const k of kept) console.log(`  kept as OTHER: ${k.challanNo} ${k.billMonth} ${k.student} "${k.label}" Rs ${k.amount}`);

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply to make these changes.');
    return;
  }

  const backupPath = join(__dirname, '..', `_fee_item_recategorize_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(backupPath, JSON.stringify({ takenAt: new Date().toISOString(), changes, kept }, null, 2));
  console.log(`\nBackup written: ${backupPath}`);

  let updated = 0;
  await prisma.$transaction(async (tx) => {
    for (const c of changes) {
      // Only while the line is still exactly what was read.
      const r = await tx.feeChallanItem.updateMany({
        where: { id: c.itemId, type: FeeItemType.OTHER, label: c.label },
        data: { type: c.to },
      });
      updated += r.count;
    }
    // One round trip per line to a remote database outlasts Prisma's 5 s default.
  }, { timeout: 120_000, maxWait: 20_000 });
  console.log(`Updated ${updated} of ${changes.length} lines.`);

  await logAudit(null, {
    action: 'UPDATE',
    module: 'FEES',
    targetType: 'FeeChallanItem',
    targetLabel: `${updated} hand-typed challan lines re-filed`,
    details:
      `Hand-typed "Other" lines filed under their real category (amounts unchanged): ` +
      Object.entries(tally).map(([to, t]) => `${t.lines} → ${to} (Rs ${t.amount})`).join(', ') +
      `. ${kept.length} ambiguous lines left as Other.`,
    changes: { lines: changes.map((c) => ({ challan: c.challanNo, label: c.label, amount: c.amount, before: c.from, after: c.to })) },
    actorName: 'System (data cleanup)',
    actorRole: 'SUPERADMIN',
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
