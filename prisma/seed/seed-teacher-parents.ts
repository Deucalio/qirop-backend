/**
 * One-time script: backfills `fatherName` and `gender` for existing teachers
 * who were created before these fields became required.
 *
 * Usage:  npx tsx prisma/seed/seed-teacher-parents.ts
 *
 * Safe to re-run — only touches rows where fatherName is the migration default.
 */
import 'dotenv/config';
import { PrismaClient, Gender } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const teachers = await prisma.teacherProfile.findMany({
    where: {
      OR: [
        { fatherName: '[NEEDS UPDATE]' },
        { fatherName: '' },
      ],
    },
    include: { user: { select: { fullName: true, cnic: true } } },
  });

  if (teachers.length === 0) {
    console.log('✅ All teachers already have parent info. Nothing to do.');
    return;
  }

  console.log(`Found ${teachers.length} teacher(s) without parent info:\n`);

  for (const t of teachers) {
    // Default gender to MALE; admin should edit in the UI.
    await prisma.teacherProfile.update({
      where: { id: t.id },
      data: {
        gender: t.gender ?? Gender.MALE,
        fatherName: t.fatherName === '[NEEDS UPDATE]' || t.fatherName === ''
          ? '[NEEDS UPDATE]'
          : t.fatherName,
      },
    });
    console.log(`  → ${t.user.fullName} (${t.user.cnic}) — gender: MALE (default), fatherName: [NEEDS UPDATE]`);
  }

  console.log(`\n✅ Updated ${teachers.length} teacher(s).`);
  console.log('   Please edit their parent info in Staff Management → Edit Details.');
}

main()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async (err) => {
    console.error('❌ Script failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
