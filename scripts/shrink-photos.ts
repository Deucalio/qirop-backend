/**
 * Re-encode the photos that were uploaded before uploads were optimised.
 *
 * `uploadFile` already runs `optimizeImageBuffer`, so anything uploaded today is
 * fine. The files on disk average 3.6 MB because they predate that — and every
 * one is proxied through the Node process on its way to the browser, so a page
 * of twenty avatars moves ~72 MB in and the same out, on a single thread. That
 * is what starves unrelated API requests.
 *
 * Each photo is fetched, pushed back through the real `replaceFile` path (which
 * optimises and deletes the old file), and the new path stored. Reusing the
 * production path rather than re-implementing it means this cannot drift from
 * what a fresh upload produces.
 *
 * Run it ON THE SERVER: it moves hundreds of megabytes to and from FileStore,
 * which is quick from the VPS and impractical over a home connection.
 *
 *   npx tsx scripts/shrink-photos.ts          # dry run, writes nothing
 *   npx tsx scripts/shrink-photos.ts --apply
 */
import { prisma } from '../src/config/prisma';
import { fetchFileBuffer, replaceFile, optimizeImageBuffer } from '../src/services/storage';

const APPLY = process.argv.includes('--apply');
const MB = (n: number) => `${(n / 1048576).toFixed(2)} MB`;

interface Target {
  kind: string;
  id: string;
  label: string;
  path: string;
  dir: string;
  save: (newPath: string) => Promise<unknown>;
}

(async () => {
  const targets: Target[] = [];

  for (const s of await prisma.student.findMany({ where: { photoUrl: { not: null } }, select: { id: true, admissionNo: true, photoUrl: true } })) {
    targets.push({
      kind: 'student', id: s.id, label: s.admissionNo, path: s.photoUrl!, dir: `/students/${s.id}`,
      save: (p) => prisma.student.update({ where: { id: s.id }, data: { photoUrl: p } }),
    });
  }
  for (const t of await prisma.teacherProfile.findMany({ where: { user: { avatarUrl: { not: null } } }, select: { id: true, employeeId: true, user: { select: { id: true, avatarUrl: true } } } })) {
    targets.push({
      kind: 'staff', id: t.id, label: t.employeeId, path: t.user.avatarUrl!, dir: `/teachers/${t.id}`,
      save: (p) => prisma.user.update({ where: { id: t.user.id }, data: { avatarUrl: p } }),
    });
  }
  // Admins and system users with an avatar but no staff profile.
  for (const u of await prisma.user.findMany({ where: { avatarUrl: { not: null }, teacherProfile: null }, select: { id: true, fullName: true, avatarUrl: true } })) {
    targets.push({
      kind: 'user', id: u.id, label: u.fullName, path: u.avatarUrl!, dir: `/users/${u.id}`,
      save: (p) => prisma.user.update({ where: { id: u.id }, data: { avatarUrl: p } }),
    });
  }
  const school = await prisma.school.findFirst({ select: { id: true, name: true, logoUrl: true } });
  if (school?.logoUrl) {
    targets.push({
      kind: 'logo', id: school.id, label: school.name, path: school.logoUrl, dir: '/logo',
      save: (p) => prisma.school.update({ where: { id: school.id }, data: { logoUrl: p } }),
    });
  }

  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — re-encoding ${targets.length} image(s)\n`);

  let before = 0, after = 0, done = 0, skipped = 0, failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const file = await fetchFileBuffer(t.path);
    if (!file) { failed++; console.log(`  ${String(i + 1).padStart(3)}. ${t.kind}/${t.label}: could not fetch — left alone`); continue; }

    const opt = await optimizeImageBuffer(file.buffer, t.path.split('/').pop() ?? 'photo.jpg', file.contentType);
    before += file.buffer.length;
    after += opt.buffer.length;

    // Anything already small gains nothing from a round trip through storage.
    if (opt.buffer.length >= file.buffer.length * 0.9) {
      skipped++;
      console.log(`  ${String(i + 1).padStart(3)}. ${t.kind}/${t.label}: ${MB(file.buffer.length)} — already small, skipping`);
      continue;
    }

    console.log(`  ${String(i + 1).padStart(3)}. ${t.kind}/${t.label}: ${MB(file.buffer.length)} -> ${MB(opt.buffer.length)}`);
    if (APPLY) {
      const newPath = await replaceFile(t.path, file.buffer, t.path.split('/').pop() ?? 'photo.jpg', t.dir, file.contentType);
      await t.save(newPath);
      done++;
    }
  }

  console.log(`\n  images        : ${targets.length}`);
  console.log(`  total before  : ${MB(before)}`);
  console.log(`  total after   : ${MB(after)}`);
  console.log(`  saved         : ${MB(before - after)}  (${before ? (100 - (after / before) * 100).toFixed(1) : 0}% smaller)`);
  console.log(`  rewritten     : ${done}   already small: ${skipped}   unreadable: ${failed}`);
  if (!APPLY) console.log('\n  Dry run only. Re-run with --apply to write.\n');
})().catch((e) => { console.error('\nFAILED:', e.message, '\n'); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
