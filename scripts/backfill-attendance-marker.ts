/**
 * Recover who marked historic staff attendance, from the audit log.
 *
 * `TeacherAttendance.markedById` was added after the fact, so every row written
 * before it exists with a null marker and the UI honestly reports "Not
 * recorded". But the information is not actually lost: every staff-attendance
 * write has always been audited with the acting user, the date, and the staff
 * it covered. This reads that back and stamps the rows.
 *
 * Two audit shapes carry it:
 *
 *   targetType 'TeacherAttendance' — a batch mark. `changes._meta.date` is the
 *     day and `changes._meta.entries[].teacher` names the staff, by FULL NAME
 *     rather than id (the audit is written to be readable by a person).
 *
 *   targetType 'Teacher' — a single correction. `targetId` is the teacher and
 *     the day is in the details sentence.
 *
 * Rows are applied oldest-first so the most recent edit to a given day wins,
 * and only rows whose marker is still null are touched — a real stamp written
 * by the running application is never overwritten.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   npx tsx scripts/backfill-attendance-marker.ts
 *   npx tsx scripts/backfill-attendance-marker.ts --apply
 */
import { prisma } from '../src/config/prisma';
import { parsePktDay } from '../src/utils/pktDate';

const APPLY = process.argv.includes('--apply');

type Meta = { date?: string; entries?: { teacher?: string }[] };

/** "…to PRESENT on 2026-08-21" → "2026-08-21". */
function dateFromDetails(details: string): string | null {
  const m = details.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return m ? m[1] : null;
}

async function main() {
  const teachers = await prisma.teacherProfile.findMany({
    select: { id: true, user: { select: { fullName: true } } },
  });

  // Names are how the audit refers to staff, so the map has to go that way.
  // Anyone sharing a name is unresolvable and is reported rather than guessed.
  const byName = new Map<string, string[]>();
  for (const t of teachers) {
    const key = t.user.fullName.trim().toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), t.id]);
  }
  const ambiguous = [...byName.entries()].filter(([, ids]) => ids.length > 1);

  const logs = await prisma.auditLog.findMany({
    where: { module: 'ATTENDANCE', targetType: { in: ['Teacher', 'TeacherAttendance'] } },
    select: { actorId: true, actorName: true, targetType: true, targetId: true, details: true, changes: true, timestamp: true },
    // Oldest first: a later correction to the same day should win.
    orderBy: { timestamp: 'asc' },
  });

  // Some early rows recorded only the actor's name. Resolve those to a user.
  const names = [...new Set(logs.filter((l) => !l.actorId).map((l) => l.actorName))];
  const users = names.length
    ? await prisma.user.findMany({ where: { fullName: { in: names } }, select: { id: true, fullName: true } })
    : [];
  const userByName = new Map(users.map((u) => [u.fullName, u.id]));

  /** (teacherId|yyyy-mm-dd) -> who last set it, and when they did. */
  const marker = new Map<string, { actor: string; at: Date }>();
  let unresolvedActor = 0;
  let unresolvedTeacher = 0;

  for (const l of logs) {
    const actor = l.actorId ?? userByName.get(l.actorName) ?? null;
    if (!actor) {
      unresolvedActor++;
      continue;
    }

    if (l.targetType === 'TeacherAttendance') {
      const meta = (l.changes as { _meta?: Meta } | null)?._meta;
      if (!meta?.date || !Array.isArray(meta.entries)) continue;
      for (const e of meta.entries) {
        const name = e.teacher?.trim().toLowerCase();
        if (!name) continue;
        const ids = byName.get(name);
        if (!ids || ids.length !== 1) {
          unresolvedTeacher++;
          continue;
        }
        marker.set(`${ids[0]}|${meta.date}`, { actor, at: l.timestamp });
      }
    } else {
      const day = dateFromDetails(l.details);
      if (!day || !l.targetId) continue;
      marker.set(`${l.targetId}|${day}`, { actor, at: l.timestamp });
    }
  }

  // Anything still missing EITHER field. markedAt was added after markedById,
  // so a row can already carry a marker and still have no time.
  const blanks = await prisma.teacherAttendance.findMany({
    where: { OR: [{ markedById: null }, { markedAt: null }] },
    select: { id: true, teacherId: true, date: true },
  });

  const planned: { id: string; markedById: string; at: Date }[] = [];
  for (const row of blanks) {
    const day = row.date.toISOString().slice(0, 10);
    const who = marker.get(`${row.teacherId}|${day}`);
    if (who) planned.push({ id: row.id, markedById: who.actor, at: who.at });
  }

  const distinctActors = new Set(planned.map((p) => p.markedById));
  console.log(`audit rows read            : ${logs.length}`);
  console.log(`(teacher, day) pairs found : ${marker.size}`);
  console.log(`rows missing marker or time: ${blanks.length}`);
  console.log(`  -> recoverable           : ${planned.length}`);
  console.log(`  -> still unknown         : ${blanks.length - planned.length}`);
  console.log(`distinct markers           : ${distinctActors.size}`);
  if (unresolvedActor) console.log(`audit rows with no resolvable actor: ${unresolvedActor}`);
  if (unresolvedTeacher) console.log(`audit entries with no unique staff match: ${unresolvedTeacher}`);
  if (ambiguous.length) {
    console.log(`\nstaff sharing a full name (never guessed, left unmarked):`);
    for (const [name, ids] of ambiguous) console.log(`   "${name}" x${ids.length}`);
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply to stamp ${planned.length} row(s).`);
    return;
  }

  /*
   * Every row carries its own audit timestamp, so these cannot collapse into a
   * few updateMany calls the way one shared value could. They are chunked into
   * transactions instead; a few hundred rows is a handful of round-trips.
   *
   * `updatedAt` moves as a side effect of each write, which is precisely why
   * the displayed time no longer reads from it.
   */
  const CHUNK = 50;
  let written = 0;
  for (let i = 0; i < planned.length; i += CHUNK) {
    const slice = planned.slice(i, i + CHUNK);
    await prisma.$transaction(
      slice.map((p) =>
        prisma.teacherAttendance.update({
          where: { id: p.id },
          data: { markedById: p.markedById, markedAt: p.at },
        }),
      ),
    );
    written += slice.length;
  }
  console.log(`\nstamped ${written} row(s) with a marker and a true marking time.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
