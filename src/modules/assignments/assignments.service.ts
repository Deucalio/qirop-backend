import { UserStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError, NotFound } from '../../utils/apiResponse';

const conflict = (message: string, code = 'CONFLICT') => new AppError(message, 409, code);

async function loadActiveTeacherOr404(teacherId: string) {
  const teacher = await prisma.teacherProfile.findUnique({
    where: { id: teacherId },
    include: { user: true },
  });
  if (!teacher) throw NotFound('Teacher not found');
  return teacher;
}

export async function setClassTeacher(sectionId: string, teacherId: string | null) {
  const section = await prisma.section.findUnique({ where: { id: sectionId } });
  if (!section) throw NotFound('Section not found');

  if (teacherId) {
    const teacher = await loadActiveTeacherOr404(teacherId);
    if (teacher.status !== UserStatus.ACTIVE) {
      throw conflict('Cannot set an inactive teacher as class teacher', 'TEACHER_INACTIVE');
    }
  }

  await prisma.section.update({ where: { id: sectionId }, data: { classTeacherId: teacherId } });
  return getSectionTeachingAssignments(sectionId);
}

export async function getSectionTeachingAssignments(sectionId: string) {
  const section = await prisma.section.findUnique({
    where: { id: sectionId },
    include: {
      class: { include: { classSubjects: { include: { subject: true } } } },
      classTeacher: { include: { user: true } },
      teachingAssignments: { include: { teacher: { include: { user: true } }, subject: true } },
    },
  });
  if (!section) throw NotFound('Section not found');

  const bySubject = new Map(section.teachingAssignments.map((ta) => [ta.subjectId, ta]));

  return {
    sectionId: section.id,
    sectionName: section.name,
    classId: section.classId,
    className: section.class.name,
    classTeacher: section.classTeacher
      ? { id: section.classTeacher.id, fullName: section.classTeacher.user.fullName }
      : null,
    assignments: section.class.classSubjects
      .map((cs) => cs.subject)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((subject) => {
        const ta = bySubject.get(subject.id);
        return {
          subjectId: subject.id,
          subjectName: subject.name,
          teacher: ta ? { id: ta.teacher.id, fullName: ta.teacher.user.fullName } : null,
        };
      }),
  };
}

export async function upsertTeachingAssignment(sectionId: string, subjectId: string, teacherId: string) {
  const section = await prisma.section.findUnique({ where: { id: sectionId } });
  if (!section) throw NotFound('Section not found');

  // The subject must be offered by the section's class (ClassSubject).
  const offered = await prisma.classSubject.findUnique({
    where: { classId_subjectId: { classId: section.classId, subjectId } },
  });
  if (!offered) {
    throw conflict('This subject is not offered in this class', 'SUBJECT_NOT_OFFERED');
  }

  const teacher = await loadActiveTeacherOr404(teacherId);
  if (teacher.status !== UserStatus.ACTIVE) {
    throw conflict('Cannot assign an inactive teacher', 'TEACHER_INACTIVE');
  }

  // If this subject is on the section's timetable, the replacement teacher must
  // be free at every scheduled (day, period) — no double-booking across sections.
  const scheduled = await prisma.timetableSlot.findMany({ where: { sectionId, subjectId } });
  if (scheduled.length > 0) {
    const others = await prisma.timetableSlot.findMany({
      where: {
        sectionId: { not: sectionId },
        OR: scheduled.map((s) => ({ day: s.day, periodIndex: s.periodIndex })),
      },
      include: { section: { include: { class: true } }, subject: true },
    });
    if (others.length > 0) {
      const taught = await prisma.teachingAssignment.findMany({
        where: { teacherId, OR: others.map((o) => ({ sectionId: o.sectionId, subjectId: o.subjectId })) },
      });
      const owned = new Set(taught.map((a) => `${a.sectionId}:${a.subjectId}`));
      const clash = others.find((o) => owned.has(`${o.sectionId}:${o.subjectId}`));
      if (clash) {
        throw conflict(
          `${teacher.user.fullName} is already scheduled for ${clash.subject.name} in ${clash.section.class.name} · Section ${clash.section.name} (${clash.day} P${clash.periodIndex}). Resolve the timetable clash first.`,
          'TEACHER_CLASH',
        );
      }
    }
  }

  // Upholds @@unique([sectionId, subjectId]) — replaces any existing teacher.
  await prisma.teachingAssignment.upsert({
    where: { sectionId_subjectId: { sectionId, subjectId } },
    create: { sectionId, subjectId, teacherId },
    update: { teacherId },
  });

  return getSectionTeachingAssignments(sectionId);
}

export async function deleteTeachingAssignment(sectionId: string, subjectId: string) {
  const section = await prisma.section.findUnique({ where: { id: sectionId } });
  if (!section) throw NotFound('Section not found');

  // Block un-assigning while the subject is still on this section's timetable.
  const slots = await prisma.timetableSlot.findMany({
    where: { sectionId, subjectId },
    include: { subject: true },
    orderBy: [{ day: 'asc' }, { periodIndex: 'asc' }],
  });
  if (slots.length > 0) {
    const where = slots.map((s) => `${s.day} P${s.periodIndex}`).join(', ');
    throw new AppError(
      `${slots[0].subject.name} is scheduled on this section's timetable (${where}). Remove those periods or assign a different teacher instead.`,
      409,
      'SUBJECT_ON_TIMETABLE',
      { slots: slots.map((s) => ({ day: s.day, periodIndex: s.periodIndex })) },
    );
  }

  await prisma.teachingAssignment.deleteMany({ where: { sectionId, subjectId } });
  return getSectionTeachingAssignments(sectionId);
}
