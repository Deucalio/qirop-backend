import { prisma } from '../../config/prisma';
import { AppError, NotFound } from '../../utils/apiResponse';

const conflict = (message: string) => new AppError(message, 409, 'CONFLICT');

// ===========================================================================
// Classes
// ===========================================================================

export async function listClasses() {
  const classes = await prisma.class.findMany({
    orderBy: { order: 'asc' },
    include: { _count: { select: { sections: true, classSubjects: true } } },
  });
  return classes.map((c) => ({
    id: c.id,
    name: c.name,
    order: c.order,
    sectionCount: c._count.sections,
    subjectCount: c._count.classSubjects,
  }));
}

async function assertClassNameFree(name: string, exceptId?: string) {
  const existing = await prisma.class.findUnique({ where: { name } });
  if (existing && existing.id !== exceptId) {
    throw conflict(`A class named "${name}" already exists`);
  }
}

export async function createClass(name: string, order: number) {
  await assertClassNameFree(name);
  return prisma.class.create({ data: { name, order } });
}

export async function updateClass(id: string, data: { name?: string; order?: number }) {
  const cls = await prisma.class.findUnique({ where: { id } });
  if (!cls) throw NotFound('Class not found');
  if (data.name && data.name !== cls.name) {
    await assertClassNameFree(data.name, id);
  }
  return prisma.class.update({
    where: { id },
    data: { name: data.name ?? undefined, order: data.order ?? undefined },
  });
}

export async function deleteClass(id: string) {
  const cls = await prisma.class.findUnique({
    where: { id },
    include: { _count: { select: { sections: true } } },
  });
  if (!cls) throw NotFound('Class not found');

  if (cls._count.sections > 0) {
    throw conflict('Cannot delete a class that still has sections. Remove its sections first.');
  }
  const studentCount = await prisma.student.count({ where: { section: { classId: id } } });
  if (studentCount > 0) {
    throw conflict('Cannot delete a class that still has students.');
  }

  await prisma.class.delete({ where: { id } });
}

// ===========================================================================
// Sections
// ===========================================================================

async function loadClassOr404(classId: string) {
  const cls = await prisma.class.findUnique({ where: { id: classId } });
  if (!cls) throw NotFound('Class not found');
  return cls;
}

export async function listSections(classId: string) {
  await loadClassOr404(classId);
  const sections = await prisma.section.findMany({
    where: { classId },
    orderBy: { name: 'asc' },
    include: { _count: { select: { students: true } } },
  });
  return sections.map((s) => ({
    id: s.id,
    name: s.name,
    classId: s.classId,
    classTeacherId: s.classTeacherId,
    studentCount: s._count.students,
  }));
}

export async function createSection(classId: string, name: string) {
  await loadClassOr404(classId);
  const existing = await prisma.section.findUnique({
    where: { classId_name: { classId, name } },
  });
  if (existing) throw conflict(`Section "${name}" already exists in this class`);
  return prisma.section.create({ data: { classId, name } });
}

export async function updateSection(id: string, name: string) {
  const section = await prisma.section.findUnique({ where: { id } });
  if (!section) throw NotFound('Section not found');
  if (name !== section.name) {
    const clash = await prisma.section.findUnique({
      where: { classId_name: { classId: section.classId, name } },
    });
    if (clash) throw conflict(`Section "${name}" already exists in this class`);
  }
  return prisma.section.update({ where: { id }, data: { name } });
}

export async function deleteSection(id: string) {
  const section = await prisma.section.findUnique({
    where: { id },
    include: { _count: { select: { students: true } } },
  });
  if (!section) throw NotFound('Section not found');
  if (section._count.students > 0) {
    throw conflict('Cannot delete a section that still has students.');
  }
  await prisma.section.delete({ where: { id } });
}

// ===========================================================================
// Subjects
// ===========================================================================

export async function listSubjects() {
  const subjects = await prisma.subject.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { classSubjects: true } } },
  });
  return subjects.map((s) => ({
    id: s.id,
    name: s.name,
    classCount: s._count.classSubjects,
  }));
}

async function assertSubjectNameFree(name: string, exceptId?: string) {
  const existing = await prisma.subject.findUnique({ where: { name } });
  if (existing && existing.id !== exceptId) {
    throw conflict(`A subject named "${name}" already exists`);
  }
}

export async function createSubject(name: string) {
  await assertSubjectNameFree(name);
  return prisma.subject.create({ data: { name } });
}

export async function updateSubject(id: string, name: string) {
  const subject = await prisma.subject.findUnique({ where: { id } });
  if (!subject) throw NotFound('Subject not found');
  if (name !== subject.name) await assertSubjectNameFree(name, id);
  return prisma.subject.update({ where: { id }, data: { name } });
}

export async function deleteSubject(id: string) {
  const subject = await prisma.subject.findUnique({
    where: { id },
    include: { _count: { select: { classSubjects: true } } },
  });
  if (!subject) throw NotFound('Subject not found');
  if (subject._count.classSubjects > 0) {
    throw conflict('Cannot delete a subject that is mapped to one or more classes.');
  }
  await prisma.subject.delete({ where: { id } });
}

// ===========================================================================
// Class ↔ Subject mapping
// ===========================================================================

export async function getClassSubjects(classId: string) {
  await loadClassOr404(classId);
  const links = await prisma.classSubject.findMany({
    where: { classId },
    include: { subject: true },
    orderBy: { subject: { name: 'asc' } },
  });
  return links.map((l) => ({ id: l.subject.id, name: l.subject.name }));
}

export async function setClassSubjects(classId: string, subjectIds: string[]) {
  await loadClassOr404(classId);
  const uniqueIds = [...new Set(subjectIds)];

  if (uniqueIds.length > 0) {
    const found = await prisma.subject.findMany({ where: { id: { in: uniqueIds } }, select: { id: true } });
    if (found.length !== uniqueIds.length) {
      throw new AppError('One or more subjectIds do not exist', 400, 'INVALID_SUBJECT');
    }
  }

  const current = await prisma.classSubject.findMany({ where: { classId }, select: { subjectId: true } });
  const currentIds = new Set(current.map((c) => c.subjectId));
  const nextIds = new Set(uniqueIds);

  const toAdd = uniqueIds.filter((id) => !currentIds.has(id));
  const toRemove = [...currentIds].filter((id) => !nextIds.has(id));

  await prisma.$transaction([
    ...(toRemove.length
      ? [
          // A subject no longer offered by the class cannot keep its per-section
          // teacher assignments — drop them so they don't silently resurface if
          // the subject is mapped to the class again later.
          prisma.teachingAssignment.deleteMany({
            where: { subjectId: { in: toRemove }, section: { classId } },
          }),
          prisma.classSubject.deleteMany({ where: { classId, subjectId: { in: toRemove } } }),
        ]
      : []),
    ...(toAdd.length
      ? [prisma.classSubject.createMany({ data: toAdd.map((subjectId) => ({ classId, subjectId })) })]
      : []),
  ]);

  return getClassSubjects(classId);
}
