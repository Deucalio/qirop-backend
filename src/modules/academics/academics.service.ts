import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError, NotFound } from '../../utils/apiResponse';
import {
  buildValidity,
  getTimetableLayout,
  totalWeeklySlots,
  type TimetableStatus,
} from '../timetable/timetable.service';
import { BUILT_IN_COLORS, normalizeHex } from './subjectColors';
import { logAudit } from '../audit/audit.service';

const conflict = (message: string) => new AppError(message, 409, 'CONFLICT');

// ===========================================================================
// Classes
// ===========================================================================

/**
 * Sort position derived from the class name: the first number in it
 * ("Class 10" → 10). Names without a number (Nursery, KG, …) get 0 so they
 * sort before Class 1; ties fall back to alphabetical order.
 */
function classOrderFromName(name: string): number {
  const match = /\d+/.exec(name);
  return match ? parseInt(match[0], 10) : 0;
}

/**
 * Roll the per-section timetable states up to one badge for the class:
 * anything expired wins, then anything unfinished, else active.
 */
function aggregateTimetableStatus(statuses: TimetableStatus[]): TimetableStatus {
  if (statuses.length === 0 || statuses.every((s) => s === 'EMPTY')) return 'EMPTY';
  if (statuses.includes('EXPIRED')) return 'EXPIRED';
  if (statuses.some((s) => s === 'INCOMPLETE' || s === 'EMPTY')) return 'INCOMPLETE';
  return 'ACTIVE';
}

export async function listClasses() {
  const [classes, periodConfig] = await Promise.all([
    prisma.class.findMany({
      include: {
        _count: { select: { sections: true, classSubjects: true } },
        feeStructure: true,
        sections: {
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            isDefault: true,
            timetableFrom: true,
            timetableUntil: true,
            classTeacher: { include: { user: { select: { fullName: true } } } },
            _count: { select: { students: true, timetableSlots: true } },
          },
        },
      },
    }),
    getTimetableLayout(),
  ]);
  const weeklySlots = totalWeeklySlots(periodConfig);

  // Self-heal: `order` is now always derived from the name. Fix any stale rows
  // (created before auto-ordering) so every query sorting on `order` agrees.
  const stale = classes.filter((c) => c.order !== classOrderFromName(c.name));
  if (stale.length > 0) {
    await prisma.$transaction(
      stale.map((c) =>
        prisma.class.update({ where: { id: c.id }, data: { order: classOrderFromName(c.name) } }),
      ),
    );
    for (const c of stale) c.order = classOrderFromName(c.name);
  }

  return classes
    .map((c) => ({
      id: c.id,
      name: c.name,
      order: c.order,
      // The implicit section isn't a section the school has — don't count it.
      sectionCount: c.sections.filter((s) => !s.isDefault).length,
      subjectCount: c._count.classSubjects,
      studentCount: c.sections.reduce((n, s) => n + s._count.students, 0),
      // Fee structure — `hasStructure` is false when no monthly fee is set, so
      // the UI can flag the class (no challans generate for a zero-fee class).
      monthlyFee: (c.feeStructure?.monthlyFee ?? new Prisma.Decimal(0)).toFixed(2),
      admissionFee: (c.feeStructure?.admissionFee ?? new Prisma.Decimal(0)).toFixed(2),
      hasStructure: !!c.feeStructure && c.feeStructure.monthlyFee.greaterThan(0),
      timetableStatus: aggregateTimetableStatus(
        c.sections.map((s) => buildValidity(s, s._count.timetableSlots, weeklySlots).status),
      ),
      /** Class teacher per section, for the card summary. */
      classTeachers: c.sections.map((s) => ({
        sectionId: s.id,
        sectionName: s.name,
        isDefault: s.isDefault,
        teacherName: s.classTeacher?.user.fullName ?? null,
      })),
    }))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

async function assertClassNameFree(name: string, exceptId?: string) {
  const existing = await prisma.class.findUnique({ where: { name } });
  if (existing && existing.id !== exceptId) {
    throw conflict(`A class named "${name}" already exists`);
  }
}

/** Name of the implicit section used by classes that aren't split into sections. */
export const DEFAULT_SECTION_NAME = 'Main';

/**
 * Create a class and its sections. A class always ends up with at least one
 * section — students, timetables and attendance all hang off sections — so when
 * no names are given we add one flagged `isDefault`, which the UI presents as
 * "no sections" rather than inventing a letter the school doesn't use.
 */
export async function createClass(
  name: string,
  sectionNames: string[] = [],
  fees?: { monthlyFee?: string; admissionFee?: string },
  actorId?: string,
) {
  await assertClassNameFree(name);

  const cleaned = [...new Set(sectionNames.map((s) => s.trim()).filter(Boolean))];
  const monthly = fees?.monthlyFee != null ? new Prisma.Decimal(fees.monthlyFee) : null;
  const admission = fees?.admissionFee != null ? new Prisma.Decimal(fees.admissionFee) : new Prisma.Decimal(0);
  const cls = await prisma.class.create({
    data: {
      name,
      order: classOrderFromName(name),
      sections: {
        create: cleaned.length
          ? cleaned.map((n) => ({ name: n }))
          : [{ name: DEFAULT_SECTION_NAME, isDefault: true }],
      },
      ...(monthly && monthly.greaterThan(0)
        ? { feeStructure: { create: { monthlyFee: monthly, admissionFee: admission } } }
        : {}),
    },
  });

  const classLabel = cls.name.trim().toLowerCase().startsWith('class') ? cls.name.trim() : `Class ${cls.name.trim()}`;
  await logAudit(null, {
    actorId: actorId ?? null,
    action: 'CREATE',
    module: 'TIMETABLE',
    targetType: 'Class',
    targetId: cls.id,
    targetLabel: classLabel,
    details: `Created new ${classLabel} with ${cleaned.length || 1} section(s)`,
    changes: {
      name: { before: null, after: cls.name },
      monthlyFee: { before: null, after: fees?.monthlyFee ?? '0.00' },
    },
  });

  return cls;
}

export async function updateClass(id: string, data: { name: string }, actorId?: string) {
  const cls = await prisma.class.findUnique({ where: { id } });
  if (!cls) throw NotFound('Class not found');
  if (data.name !== cls.name) {
    await assertClassNameFree(data.name, id);
  }
  const updated = await prisma.class.update({
    where: { id },
    data: { name: data.name, order: classOrderFromName(data.name) },
  });

  if (cls.name !== data.name) {
    const oldLabel = cls.name.trim().toLowerCase().startsWith('class') ? cls.name.trim() : `Class ${cls.name.trim()}`;
    const newLabel = data.name.trim().toLowerCase().startsWith('class') ? data.name.trim() : `Class ${data.name.trim()}`;
    await logAudit(null, {
      actorId: actorId ?? null,
      action: 'UPDATE',
      module: 'TIMETABLE',
      targetType: 'Class',
      targetId: id,
      targetLabel: newLabel,
      details: `Renamed ${oldLabel} to ${newLabel}`,
      changes: {
        name: { before: cls.name, after: data.name },
      },
    });
  }

  return updated;
}

export async function deleteClass(id: string, actorId?: string) {
  const cls = await prisma.class.findUnique({
    where: { id },
    include: { sections: { select: { id: true, isDefault: true } } },
  });
  if (!cls) throw NotFound('Class not found');

  const namedSections = cls.sections.filter((s) => !s.isDefault);
  if (namedSections.length > 0) {
    throw conflict('Cannot delete a class that still has sections. Remove its sections first.');
  }
  const studentCount = await prisma.student.count({ where: { section: { classId: id } } });
  if (studentCount > 0) {
    throw conflict('Cannot delete a class that still has students.');
  }

  await prisma.$transaction([
    prisma.section.deleteMany({ where: { classId: id } }),
    prisma.class.delete({ where: { id } }),
  ]);

  const classLabel = cls.name.trim().toLowerCase().startsWith('class') ? cls.name.trim() : `Class ${cls.name.trim()}`;
  await logAudit(null, {
    actorId: actorId ?? null,
    action: 'DELETE',
    module: 'TIMETABLE',
    targetType: 'Class',
    targetId: id,
    targetLabel: classLabel,
    details: `Deleted ${classLabel}`,
  });
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
  // Classes created before implicit sections existed may have none; give them
  // one so their timetable and roster have somewhere to live.
  const existing = await prisma.section.count({ where: { classId } });
  if (existing === 0) {
    await prisma.section.create({ data: { classId, name: DEFAULT_SECTION_NAME, isDefault: true } });
  }
  const [sections, layout] = await Promise.all([
    prisma.section.findMany({
      where: { classId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { students: true, timetableSlots: true } } },
    }),
    getTimetableLayout(),
  ]);
  const totalSlots = totalWeeklySlots(layout);
  return sections.map((s) => ({
    id: s.id,
    name: s.name,
    classId: s.classId,
    classTeacherId: s.classTeacherId,
    studentCount: s._count.students,
    /** True for the implicit section of a class that isn't split into sections. */
    isDefault: s.isDefault,
    timetable: buildValidity(s, s._count.timetableSlots, totalSlots),
  }));
}

export async function createSection(classId: string, name: string) {
  await loadClassOr404(classId);
  const existing = await prisma.section.findUnique({
    where: { classId_name: { classId, name } },
  });
  if (existing) throw conflict(`Section "${name}" already exists in this class`);

  // The class wasn't split into sections until now: convert its implicit section
  // rather than adding a second, so its students and timetable carry over.
  const sections = await prisma.section.findMany({ where: { classId } });
  const onlyDefault = sections.length === 1 && sections[0].isDefault;
  if (onlyDefault) {
    return prisma.section.update({
      where: { id: sections[0].id },
      data: { name, isDefault: false },
    });
  }

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

  // Removing the last section would leave the class with nowhere to hold its
  // timetable, so it reverts to the implicit "no sections" one instead.
  const siblings = await prisma.section.count({ where: { classId: section.classId } });
  if (siblings <= 1) {
    if (section.isDefault) {
      throw conflict('This class is not split into sections, so there is nothing to remove.');
    }
    await prisma.section.update({
      where: { id },
      data: { name: DEFAULT_SECTION_NAME, isDefault: true, classTeacherId: null },
    });
    return;
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
  return subjects.map((s, i) => ({
    id: s.id,
    name: s.name,
    classCount: s._count.classSubjects,
    // Chosen colour, else a built-in slot from the alphabetical rank.
    color: s.colorHex ?? BUILT_IN_COLORS[i % BUILT_IN_COLORS.length],
    /** True while the colour is still the automatic one. */
    colorIsAuto: s.colorHex === null,
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

export async function updateSubject(id: string, data: { name?: string; color?: string | null }) {
  const subject = await prisma.subject.findUnique({ where: { id } });
  if (!subject) throw NotFound('Subject not found');
  if (data.name && data.name !== subject.name) await assertSubjectNameFree(data.name, id);

  let colorHex: string | null | undefined;
  if (data.color !== undefined) {
    colorHex = data.color === null ? null : normalizeHex(data.color);
    if (colorHex) {
      // One colour per subject, or the timetable stops being readable at a glance.
      const clash = await prisma.subject.findFirst({
        where: { colorHex, id: { not: id } },
        select: { name: true },
      });
      if (clash) {
        throw conflict(`${clash.name} already uses that colour. Pick a different one.`);
      }
    }
  }

  await prisma.subject.update({
    where: { id },
    data: {
      name: data.name ?? undefined,
      // null is meaningful (revert to automatic), so only skip when not sent.
      ...(colorHex !== undefined ? { colorHex } : {}),
    },
  });
  return listSubjects();
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

/**
 * Detailed view of one subject: the classes offering it and (when the caller
 * may see staff info) every teaching assignment, i.e. who teaches it where.
 */
export async function getSubjectDetails(id: string, includeTeachers: boolean) {
  const subject = await prisma.subject.findUnique({
    where: { id },
    include: {
      classSubjects: { include: { class: true }, orderBy: { class: { order: 'asc' } } },
    },
  });
  if (!subject) throw NotFound('Subject not found');

  const classes = subject.classSubjects.map((cs) => ({
    id: cs.class.id,
    name: cs.class.name,
    order: cs.class.order,
  }));

  if (!includeTeachers) {
    return { id: subject.id, name: subject.name, classes, assignments: null };
  }

  const assignments = await prisma.teachingAssignment.findMany({
    where: { subjectId: id },
    include: { section: { include: { class: true } }, teacher: { include: { user: true } } },
    orderBy: [{ section: { class: { order: 'asc' } } }, { section: { name: 'asc' } }],
  });

  return {
    id: subject.id,
    name: subject.name,
    classes,
    assignments: assignments.map((a) => ({
      sectionId: a.sectionId,
      sectionName: a.section.name,
      classId: a.section.classId,
      className: a.section.class.name,
      teacher: { id: a.teacher.id, fullName: a.teacher.user.fullName },
    })),
  };
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
