import { PrismaClient } from '@prisma/client';

interface HwDef {
  className: string;
  sectionName: string;
  subject: string;
  title: string;
  description: string;
  dueInDays: number;
}

// Each is authored by whichever teacher is assigned to that (section, subject).
// Note the edge case: Class 5-A Math (Ayesha) and Class 5-B Math (Usman) are separate.
const HOMEWORK: HwDef[] = [
  { className: 'Class 5', sectionName: 'A', subject: 'Math', title: 'Algebra Worksheet', description: 'Complete exercises 1–10 from chapter 3.', dueInDays: 3 },
  { className: 'Class 5', sectionName: 'A', subject: 'English', title: 'Essay: My Village', description: 'Write a 200-word essay about your village.', dueInDays: 5 },
  { className: 'Class 5', sectionName: 'B', subject: 'Math', title: 'Geometry Problems', description: 'Solve the geometry problems on page 42.', dueInDays: 4 },
  { className: 'Class 1', sectionName: 'A', subject: 'Math', title: 'Counting 1–100', description: 'Practice writing numbers from 1 to 100.', dueInDays: 2 },
  { className: 'Class 1', sectionName: 'A', subject: 'Urdu', title: 'Urdu Alphabets', description: 'Practice the first 10 Urdu alphabets.', dueInDays: 6 },
];

async function sectionId(prisma: PrismaClient, className: string, sectionName: string) {
  const s = await prisma.section.findFirst({ where: { name: sectionName, class: { name: className } }, select: { id: true } });
  return s?.id ?? null;
}

/** Idempotent: skips a homework if one with the same (section, subject, title) already exists. */
export async function seedHomework(prisma: PrismaClient) {
  for (const d of HOMEWORK) {
    const sid = await sectionId(prisma, d.className, d.sectionName);
    const subject = await prisma.subject.findUnique({ where: { name: d.subject }, select: { id: true } });
    if (!sid || !subject) continue;

    const ta = await prisma.teachingAssignment.findUnique({
      where: { sectionId_subjectId: { sectionId: sid, subjectId: subject.id } },
      select: { teacherId: true },
    });
    if (!ta) continue; // no assigned teacher → skip (homework requires an author)

    const existing = await prisma.homework.findFirst({ where: { sectionId: sid, subjectId: subject.id, title: d.title } });
    if (existing) continue;

    await prisma.homework.create({
      data: {
        sectionId: sid,
        subjectId: subject.id,
        teacherId: ta.teacherId,
        title: d.title,
        description: d.description,
        dueDate: new Date(Date.now() + d.dueInDays * 86400000),
      },
    });
  }
}
