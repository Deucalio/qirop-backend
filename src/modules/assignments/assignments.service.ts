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
  await prisma.teachingAssignment.deleteMany({ where: { sectionId, subjectId } });
  return getSectionTeachingAssignments(sectionId);
}
