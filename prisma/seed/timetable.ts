import { PrismaClient, DayOfWeek } from '@prisma/client';

const DAYS: DayOfWeek[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

interface SlotDef {
  className: string;
  sectionName: string;
  periodIndex: number;
  subject: string;
}

// Same pattern every school day, built so no teacher is ever double-booked:
//   P1: Ayesha 5-A Math   | Bilal 5-B English | Sana 1-A Urdu
//   P2: Bilal 5-A English | Usman 5-B Math    | Ayesha 1-A Math
//   P3: Usman 5-A Science | Bilal 5-B English | Ayesha 1-A Math
//   P4: Ayesha 5-A Math   | Usman 5-B Math    | Sana 1-A Urdu
const SLOTS: SlotDef[] = [
  { className: 'Class 5', sectionName: 'A', periodIndex: 1, subject: 'Math' },
  { className: 'Class 5', sectionName: 'A', periodIndex: 2, subject: 'English' },
  { className: 'Class 5', sectionName: 'A', periodIndex: 3, subject: 'Science' },
  { className: 'Class 5', sectionName: 'A', periodIndex: 4, subject: 'Math' },
  { className: 'Class 5', sectionName: 'B', periodIndex: 1, subject: 'English' },
  { className: 'Class 5', sectionName: 'B', periodIndex: 2, subject: 'Math' },
  { className: 'Class 5', sectionName: 'B', periodIndex: 3, subject: 'English' },
  { className: 'Class 5', sectionName: 'B', periodIndex: 4, subject: 'Math' },
  { className: 'Class 1', sectionName: 'A', periodIndex: 1, subject: 'Urdu' },
  { className: 'Class 1', sectionName: 'A', periodIndex: 2, subject: 'Math' },
  { className: 'Class 1', sectionName: 'A', periodIndex: 3, subject: 'Math' },
  { className: 'Class 1', sectionName: 'A', periodIndex: 4, subject: 'Urdu' },
];

/**
 * Idempotent weekly timetable for the seeded sections. Only schedules
 * (section, subject) pairs that have a TeachingAssignment, mirroring the API's
 * NO_TEACHER_ASSIGNED rule.
 */
export async function seedTimetable(prisma: PrismaClient) {
  for (const def of SLOTS) {
    const section = await prisma.section.findFirst({
      where: { name: def.sectionName, class: { name: def.className } },
      select: { id: true },
    });
    const subject = await prisma.subject.findUnique({ where: { name: def.subject }, select: { id: true } });
    if (!section || !subject) continue;

    const assignment = await prisma.teachingAssignment.findUnique({
      where: { sectionId_subjectId: { sectionId: section.id, subjectId: subject.id } },
    });
    if (!assignment) continue; // never schedule an unassigned subject

    for (const day of DAYS) {
      await prisma.timetableSlot.upsert({
        where: { sectionId_day_periodIndex: { sectionId: section.id, day, periodIndex: def.periodIndex } },
        update: { subjectId: subject.id },
        create: { sectionId: section.id, day, periodIndex: def.periodIndex, subjectId: subject.id },
      });
    }
  }
}
