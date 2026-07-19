import { PrismaClient, Prisma, AttendanceStatus } from '@prisma/client';
import { lastNPktDays } from '../../src/utils/pktDate';

// Rotating patterns — the school currently records only Present / Absent.
const STUDENT_PATTERN: AttendanceStatus[] = ['PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'ABSENT', 'PRESENT', 'ABSENT'];
const TEACHER_PATTERN: AttendanceStatus[] = ['PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'ABSENT', 'PRESENT', 'PRESENT'];

/**
 * Seeds student + teacher attendance for the last ~7 PKT school days.
 * Idempotent via createMany({ skipDuplicates }) on the (studentId,date) /
 * (teacherId,date) unique constraints. markedById is a User (class teacher's
 * user where present, else the superadmin — exercising the admin-marked path).
 */
export async function seedAttendance(prisma: PrismaClient) {
  const days = lastNPktDays(7);

  const superadmin = await prisma.user.findFirst({ where: { role: 'SUPERADMIN' }, select: { id: true } });
  if (!superadmin) return;

  const sections = await prisma.section.findMany({
    where: { students: { some: {} } },
    include: {
      students: { where: { status: 'ACTIVE' }, select: { id: true } },
      classTeacher: { select: { userId: true } },
    },
  });

  const studentRows: Prisma.StudentAttendanceCreateManyInput[] = [];
  for (const section of sections) {
    const markedById = section.classTeacher?.userId ?? superadmin.id;
    section.students.forEach((student, si) => {
      days.forEach((date, di) => {
        studentRows.push({
          studentId: student.id,
          sectionId: section.id,
          date,
          status: STUDENT_PATTERN[(di + si) % STUDENT_PATTERN.length]!,
          markedById,
        });
      });
    });
  }
  if (studentRows.length > 0) {
    await prisma.studentAttendance.createMany({ data: studentRows, skipDuplicates: true });
  }

  const teachers = await prisma.teacherProfile.findMany({ select: { id: true } });
  const teacherRows: Prisma.TeacherAttendanceCreateManyInput[] = [];
  teachers.forEach((t, ti) => {
    days.forEach((date, di) => {
      const status = TEACHER_PATTERN[(di + ti) % TEACHER_PATTERN.length]!;
      teacherRows.push({
        teacherId: t.id,
        date,
        status,
        checkInTime: status === 'PRESENT' ? new Date(date.getTime() + 8 * 3600 * 1000) : null,
      });
    });
  });
  if (teacherRows.length > 0) {
    await prisma.teacherAttendance.createMany({ data: teacherRows, skipDuplicates: true });
  }
}
