import 'dotenv/config';
import { PrismaClient, Prisma, Role } from '@prisma/client';
import bcrypt from 'bcrypt';
import { seedPeople, DEFAULT_PEOPLE_PASSWORD } from './seed/people';
import { seedAssignments } from './seed/assignments';
import { seedAttendance } from './seed/attendance';
import { seedHomework } from './seed/homework';

const prisma = new PrismaClient();

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS ?? 12);
const SUPERADMIN_CNIC = process.env.SUPERADMIN_CNIC ?? '00000-0000000-0';
const SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD ?? 'ChangeMe#123';
const SUPERADMIN_NAME = process.env.SUPERADMIN_NAME ?? 'School Owner';

const SUBJECTS = ['English', 'Urdu', 'Math', 'Science', 'Islamiyat', 'Computer'];

// Monthly fee per class order (1..5).
const CLASS_FEES: Record<number, string> = {
  1: '2500.00',
  2: '2700.00',
  3: '3000.00',
  4: '3200.00',
  5: '3500.00',
};

function currentAcademicYear(): string {
  const now = new Date();
  const year = now.getFullYear();
  // Pakistani academic year typically starts in spring; keep it simple: Y - Y+1.
  return `${year}-${year + 1}`;
}

async function seedSchool(): Promise<void> {
  const existing = await prisma.school.findFirst();
  if (existing) return;
  await prisma.school.create({
    data: {
      name: 'Qirop School of Wisdom & Technology',
      academicYear: currentAcademicYear(),
    },
  });
}

async function seedSuperadmin(): Promise<void> {
  const passwordHash = await bcrypt.hash(SUPERADMIN_PASSWORD, BCRYPT_ROUNDS);
  await prisma.user.upsert({
    where: { cnic: SUPERADMIN_CNIC },
    // Do not overwrite an existing password on re-seed.
    update: { fullName: SUPERADMIN_NAME, role: Role.SUPERADMIN },
    create: {
      cnic: SUPERADMIN_CNIC,
      passwordHash,
      role: Role.SUPERADMIN,
      fullName: SUPERADMIN_NAME,
    },
  });
}

async function seedReferenceData(): Promise<void> {
  // Subjects
  for (const name of SUBJECTS) {
    await prisma.subject.upsert({ where: { name }, update: {}, create: { name } });
  }
  const subjects = await prisma.subject.findMany();

  // Classes 1..5 with sections A & B, ClassSubject links, and a FeeStructure.
  for (let order = 1; order <= 5; order++) {
    const name = `Class ${order}`;
    const klass = await prisma.class.upsert({
      where: { name },
      update: { order },
      create: { name, order },
    });

    for (const sectionName of ['A', 'B']) {
      await prisma.section.upsert({
        where: { classId_name: { classId: klass.id, name: sectionName } },
        update: {},
        create: { classId: klass.id, name: sectionName },
      });
    }

    for (const subject of subjects) {
      await prisma.classSubject.upsert({
        where: { classId_subjectId: { classId: klass.id, subjectId: subject.id } },
        update: {},
        create: { classId: klass.id, subjectId: subject.id },
      });
    }

    await prisma.feeStructure.upsert({
      where: { classId: klass.id },
      update: {},
      create: { classId: klass.id, monthlyFee: new Prisma.Decimal(CLASS_FEES[order] ?? '2500.00') },
    });
  }
}

async function main(): Promise<void> {
  // In dependency order: school → superadmin → academics → people → assignments.
  await seedSchool();
  await seedSuperadmin();
  await seedReferenceData();

  const peoplePasswordHash = await bcrypt.hash(DEFAULT_PEOPLE_PASSWORD, BCRYPT_ROUNDS);
  const { teachers, parents } = await seedPeople(prisma, peoplePasswordHash);
  await seedAssignments(prisma);
  await seedAttendance(prisma);
  await seedHomework(prisma);

  // eslint-disable-next-line no-console
  console.log('✅ Seed complete.');
  // eslint-disable-next-line no-console
  console.log(`   School:          Qirop School of Wisdom & Technology (${currentAcademicYear()})`);
  // eslint-disable-next-line no-console
  console.log(`   Superadmin CNIC: ${SUPERADMIN_CNIC} (password from .env SUPERADMIN_PASSWORD)`);
  // eslint-disable-next-line no-console
  console.log(`\n   Seeded people — all use password "${DEFAULT_PEOPLE_PASSWORD}":`);
  // eslint-disable-next-line no-console
  console.log('   Teachers:');
  for (const t of teachers) {
    // eslint-disable-next-line no-console
    console.log(`     ${t.cnic}  ${t.fullName}`);
  }
  // eslint-disable-next-line no-console
  console.log('   Parents:');
  for (const p of parents) {
    // eslint-disable-next-line no-console
    console.log(`     ${p.cnic}  ${p.fullName}`);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error('❌ Seed failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
