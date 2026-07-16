import { PrismaClient } from '@prisma/client';

interface ClassTeacherDef {
  className: string;
  sectionName: string;
  employeeId: string;
}
interface TeachingDef {
  className: string;
  sectionName: string;
  subject: string;
  employeeId: string;
}

// Ayesha (EMP-101) is class teacher of two sections (1-A and 2-A).
const CLASS_TEACHERS: ClassTeacherDef[] = [
  { className: 'Class 1', sectionName: 'A', employeeId: 'EMP-101' },
  { className: 'Class 1', sectionName: 'B', employeeId: 'EMP-102' },
  { className: 'Class 2', sectionName: 'A', employeeId: 'EMP-101' },
  { className: 'Class 5', sectionName: 'A', employeeId: 'EMP-103' },
  { className: 'Class 5', sectionName: 'B', employeeId: 'EMP-104' },
];

// Edge case: Class 5-A Math → Ayesha (EMP-101), Class 5-B Math → Usman (EMP-104).
// Ayesha also teaches Math in 1-A → one teacher across multiple sections/subjects.
const TEACHING: TeachingDef[] = [
  { className: 'Class 5', sectionName: 'A', subject: 'Math', employeeId: 'EMP-101' },
  { className: 'Class 5', sectionName: 'A', subject: 'English', employeeId: 'EMP-102' },
  { className: 'Class 5', sectionName: 'A', subject: 'Science', employeeId: 'EMP-104' },
  { className: 'Class 5', sectionName: 'B', subject: 'Math', employeeId: 'EMP-104' },
  { className: 'Class 5', sectionName: 'B', subject: 'English', employeeId: 'EMP-102' },
  { className: 'Class 1', sectionName: 'A', subject: 'Math', employeeId: 'EMP-101' },
  { className: 'Class 1', sectionName: 'A', subject: 'Urdu', employeeId: 'EMP-103' },
];

async function sectionId(prisma: PrismaClient, className: string, sectionName: string) {
  const s = await prisma.section.findFirst({
    where: { name: sectionName, class: { name: className } },
    select: { id: true },
  });
  return s?.id ?? null;
}
async function teacherId(prisma: PrismaClient, employeeId: string) {
  const t = await prisma.teacherProfile.findUnique({ where: { employeeId }, select: { id: true } });
  return t?.id ?? null;
}

/** Idempotent: class-teacher is a set operation; teaching assignments upsert on (section, subject). */
export async function seedAssignments(prisma: PrismaClient) {
  for (const ct of CLASS_TEACHERS) {
    const sid = await sectionId(prisma, ct.className, ct.sectionName);
    const tid = await teacherId(prisma, ct.employeeId);
    if (sid && tid) {
      await prisma.section.update({ where: { id: sid }, data: { classTeacherId: tid } });
    }
  }

  for (const ta of TEACHING) {
    const sid = await sectionId(prisma, ta.className, ta.sectionName);
    const tid = await teacherId(prisma, ta.employeeId);
    const subject = await prisma.subject.findUnique({ where: { name: ta.subject }, select: { id: true } });
    if (sid && tid && subject) {
      await prisma.teachingAssignment.upsert({
        where: { sectionId_subjectId: { sectionId: sid, subjectId: subject.id } },
        update: { teacherId: tid },
        create: { sectionId: sid, subjectId: subject.id, teacherId: tid },
      });
    }
  }
}
