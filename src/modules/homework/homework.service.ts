import { Prisma, PermissionModule, Role } from '@prisma/client';
import type { Response } from 'express';
import { prisma } from '../../config/prisma';
import { userHasPermission } from '../../utils/permissions';
import * as storage from '../../services/storage';
import { parsePktDay, pktDay } from '../../utils/pktDate';
import { AppError, Forbidden, NotFound } from '../../utils/apiResponse';
import type { CreateHomeworkInput, UpdateHomeworkInput, HomeworkListQuery } from './homework.schema';
import { logAudit } from '../audit/audit.service';
import { subjectColorMap } from '../academics/subjectColors';

const HOMEWORK = PermissionModule.HOMEWORK;

export interface Actor {
  userId: string;
  role: Role;
}

const hwInclude = {
  section: { include: { class: true } },
  subject: true,
  teacher: { include: { user: true } },
} satisfies Prisma.HomeworkInclude;

type HwWithRels = Prisma.HomeworkGetPayload<{ include: typeof hwInclude }>;

/**
 * `colors` carries the resolved subject palette — an admin's pick, or the
 * built-in slot for its alphabetical rank. Sending the raw `colorHex` instead
 * would hand the client a null for every subject nobody has recoloured, and
 * the rank it would need to fill that in lives here, not there.
 */
function shape(hw: HwWithRels, colors?: Map<string, string>) {
  return {
    id: hw.id,
    sectionId: hw.sectionId,
    sectionName: hw.section.name,
    isDefault: hw.section.isDefault,
    classId: hw.section.classId,
    className: hw.section.class.name,
    subjectId: hw.subjectId,
    subjectName: hw.subject.name,
    subjectColor: colors?.get(hw.subjectId) ?? hw.subject.colorHex ?? null,
    teacherId: hw.teacherId,
    teacherName: hw.teacher.user.fullName,
    title: hw.title,
    description: hw.description,
    dueDate: hw.dueDate,
    hasAttachment: !!hw.attachmentUrl,
    // Never expose the raw FileStore path — only our authenticated proxy link.
    attachmentUrl: hw.attachmentUrl ? `/api/homework/${hw.id}/attachment` : null,
    createdAt: hw.createdAt,
  };
}

async function teacherProfileId(userId: string): Promise<string | null> {
  const p = await prisma.teacherProfile.findUnique({ where: { userId }, select: { id: true } });
  return p?.id ?? null;
}

async function assignmentTeacherId(sectionId: string, subjectId: string): Promise<string | null> {
  const ta = await prisma.teachingAssignment.findUnique({
    where: { sectionId_subjectId: { sectionId, subjectId } },
    select: { teacherId: true },
  });
  return ta?.teacherId ?? null;
}

/** Shape a set of rows against one palette lookup. */
async function shapeAll(rows: HwWithRels[]) {
  const colors = await subjectColorMap();
  return rows.map((hw) => shape(hw, colors));
}

/** Shape a single row, palette included. */
async function shapeOne(hw: HwWithRels) {
  return shape(hw, await subjectColorMap());
}

async function loadHomework(id: string): Promise<HwWithRels> {
  const hw = await prisma.homework.findUnique({ where: { id }, include: hwInclude });
  if (!hw) throw NotFound('Homework not found');
  return hw;
}

// --- authorization -----------------------------------------------------------

/** Resolve the responsible teacherId for a (section, subject) and authorize the create. */
async function resolveCreateTeacher(actor: Actor, sectionId: string, subjectId: string): Promise<string> {
  const assigned = await assignmentTeacherId(sectionId, subjectId);
  if (actor.role === Role.TEACHER) {
    const myId = await teacherProfileId(actor.userId);
    if (!myId || assigned !== myId) {
      throw Forbidden('You can only post homework for a subject you teach in that section');
    }
    return myId;
  }
  if (!(await userHasPermission(actor.userId, actor.role, HOMEWORK, 'edit'))) {
    throw Forbidden('You do not have permission to manage homework');
  }
  if (!assigned) {
    throw new AppError('No teacher is assigned to this subject in this section', 409, 'NO_ASSIGNMENT');
  }
  return assigned;
}

/** Owner teacher or admin-with-HOMEWORK-edit may mutate. */
async function assertCanManage(actor: Actor, hw: HwWithRels): Promise<void> {
  if (actor.role === Role.TEACHER) {
    const myId = await teacherProfileId(actor.userId);
    if (myId && myId === hw.teacherId) return;
    throw Forbidden('You can only manage your own homework');
  }
  if (await userHasPermission(actor.userId, actor.role, HOMEWORK, 'edit')) return;
  throw Forbidden('You do not have permission to manage homework');
}

/** Owner teacher, admin-with-HOMEWORK-view, or a parent of a student in the section may view. */
async function assertCanView(actor: Actor, hw: HwWithRels): Promise<void> {
  if (actor.role === Role.TEACHER) {
    const myId = await teacherProfileId(actor.userId);
    if (myId && myId === hw.teacherId) return;
    throw Forbidden('You are not allowed to view this homework');
  }
  if (actor.role === Role.PARENT) {
    const count = await prisma.student.count({ where: { sectionId: hw.sectionId, parent: { userId: actor.userId } } });
    if (count > 0) return;
    throw Forbidden('This homework is not for your child’s section');
  }
  if (await userHasPermission(actor.userId, actor.role, HOMEWORK, 'view')) return;
  throw Forbidden('You do not have permission to view homework');
}

// --- operations --------------------------------------------------------------

export async function createHomework(
  actor: Actor,
  input: CreateHomeworkInput,
  file?: Express.Multer.File,
) {
  const teacherId = await resolveCreateTeacher(actor, input.sectionId, input.subjectId);
  const hw = await prisma.homework.create({
    data: {
      sectionId: input.sectionId,
      subjectId: input.subjectId,
      teacherId,
      title: input.title,
      description: input.description,
      dueDate: input.dueDate,
    },
  });
  if (file) {
    const path = await storage.uploadFile(file.buffer, file.originalname, `/homework/${hw.id}`, file.mimetype, 'document');
    await prisma.homework.update({ where: { id: hw.id }, data: { attachmentUrl: path } });
  }

  const loaded = await loadHomework(hw.id);
  const actorUser = await prisma.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });

  const rawClassName = loaded.section.class.name.trim();
  const cleanClassName = rawClassName.toLowerCase().startsWith('class') ? rawClassName : `Class ${rawClassName}`;
  const sectionLabel = loaded.section.name ? `${cleanClassName}-${loaded.section.name}` : cleanClassName;
  await logAudit(null, {
    actorId: actor.userId,
    actorName: actorUser?.fullName ?? 'Teacher',
    actorRole: actor.role,
    action: 'CREATE',
    module: 'TIMETABLE',
    targetType: 'Homework',
    targetId: hw.id,
    targetLabel: `${loaded.subject.name} Homework: "${loaded.title}"`,
    details: `Posted homework for ${loaded.subject.name} in ${sectionLabel}`,
    changes: {
      title: { before: null, after: input.title },
      dueDate: { before: null, after: input.dueDate },
    },
  });

  return shapeOne(loaded);
}

export async function updateHomework(
  actor: Actor,
  id: string,
  input: UpdateHomeworkInput,
  file?: Express.Multer.File,
) {
  const hw = await loadHomework(id);
  await assertCanManage(actor, hw);

  let attachmentUrl: string | null | undefined;
  if (file) {
    attachmentUrl = await storage.replaceFile(hw.attachmentUrl, file.buffer, file.originalname, `/homework/${id}`, file.mimetype, 'document');
  } else if (input.clearAttachment && hw.attachmentUrl) {
    await storage.deleteFile(hw.attachmentUrl);
    attachmentUrl = null;
  }

  await prisma.homework.update({
    where: { id },
    data: {
      title: input.title ?? undefined,
      description: input.description ?? undefined,
      dueDate: input.dueDate ?? undefined,
      attachmentUrl: attachmentUrl === undefined ? undefined : attachmentUrl,
    },
  });

  const updated = await loadHomework(id);
  const actorUser = await prisma.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });
  const rawUpdatedClass = updated.section.class.name.trim();
  const cleanUpdatedClass = rawUpdatedClass.toLowerCase().startsWith('class') ? rawUpdatedClass : `Class ${rawUpdatedClass}`;
  const updatedSectionLabel = updated.section.name ? `${cleanUpdatedClass}-${updated.section.name}` : cleanUpdatedClass;

  await logAudit(null, {
    actorId: actor.userId,
    actorName: actorUser?.fullName ?? 'Teacher',
    actorRole: actor.role,
    action: 'UPDATE',
    module: 'TIMETABLE',
    targetType: 'Homework',
    targetId: id,
    targetLabel: `${updated.subject.name} Homework: "${updated.title}"`,
    details: `Updated homework "${updated.title}" for ${updatedSectionLabel}`,
  });

  return shapeOne(updated);
}

export async function deleteHomework(actor: Actor, id: string) {
  const hw = await loadHomework(id);
  await assertCanManage(actor, hw);
  if (hw.attachmentUrl) await storage.deleteFile(hw.attachmentUrl);
  await prisma.homework.delete({ where: { id } });

  const actorUser = await prisma.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });
  await logAudit(null, {
    actorId: actor.userId,
    actorName: actorUser?.fullName ?? 'Teacher',
    actorRole: actor.role,
    action: 'DELETE',
    module: 'TIMETABLE',
    targetType: 'Homework',
    targetId: id,
    targetLabel: `${hw.subject.name} Homework: "${hw.title}"`,
    details: `Deleted homework "${hw.title}"`,
  });
}

export async function getHomework(actor: Actor, id: string) {
  const hw = await loadHomework(id);
  await assertCanView(actor, hw);
  return shapeOne(hw);
}

export async function downloadAttachment(actor: Actor, id: string, res: Response): Promise<void> {
  const hw = await loadHomework(id);
  await assertCanView(actor, hw);
  if (!hw.attachmentUrl) throw NotFound('This homework has no attachment');
  await storage.proxyDownload(hw.attachmentUrl, res);
}

// --- listing ------------------------------------------------------------------

/**
 * The due-date window a set of filters asks for.
 *
 * `from`/`to` and the upcoming/overdue switch both narrow the same column, so
 * they are merged here rather than fought over: an explicit `from` earlier than
 * today loses to "upcoming", and `lt today` sits alongside a `to` bound without
 * contradicting it.
 */
function dueWindow(
  from?: string,
  to?: string,
  status: 'all' | 'upcoming' | 'overdue' = 'all',
): Prisma.DateTimeFilter | undefined {
  const range: Prisma.DateTimeFilter = {};
  if (from) range.gte = parsePktDay(from);
  if (to) range.lte = parsePktDay(to);

  if (status === 'upcoming') {
    const today = pktDay();
    const asked = range.gte as Date | undefined;
    range.gte = asked && asked > today ? asked : today;
  } else if (status === 'overdue') {
    range.lt = pktDay();
  }

  return Object.keys(range).length > 0 ? range : undefined;
}

/**
 * Free-text search across the things someone would actually type.
 *
 * Every word must match somewhere, so "aleena urdu" finds Aleena's Urdu
 * homework instead of everything by Aleena plus everything in Urdu.
 */
function searchClause(search?: string): Prisma.HomeworkWhereInput[] {
  const tokens = (search ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const like = (t: string) => ({ contains: t, mode: 'insensitive' as const });
  return tokens.map((t) => ({
    OR: [
      { title: like(t) },
      { description: like(t) },
      { subject: { name: like(t) } },
      { teacher: { user: { fullName: like(t) } } },
      { section: { class: { name: like(t) } } },
      { section: { name: like(t) } },
    ],
  }));
}

type ListFilters = Partial<HomeworkListQuery>;

/** Everything except the status switch — the base the status counts are taken over. */
function baseWhere(f: ListFilters, scope: Prisma.HomeworkWhereInput): Prisma.HomeworkWhereInput {
  const and = searchClause(f.search);
  return {
    ...scope,
    ...(f.sectionId ? { sectionId: f.sectionId } : {}),
    ...(f.subjectId ? { subjectId: f.subjectId } : {}),
    ...(f.teacherId ? { teacherId: f.teacherId } : {}),
    ...(f.classId ? { section: { classId: f.classId } } : {}),
    ...(f.attachment === 'with' ? { NOT: { attachmentUrl: null } } : {}),
    ...(f.attachment === 'without' ? { attachmentUrl: null } : {}),
    ...(and.length > 0 ? { AND: and } : {}),
  };
}

const ORDER_BY: Record<string, Prisma.HomeworkOrderByWithRelationInput> = {
  dueDate_desc: { dueDate: 'desc' },
  dueDate_asc: { dueDate: 'asc' },
  createdAt_desc: { createdAt: 'desc' },
  createdAt_asc: { createdAt: 'asc' },
};

/**
 * One page of homework, plus the counts the filter bar needs.
 *
 * The upcoming/overdue tallies are taken over everything the OTHER filters
 * match, not over the page — a count that changed when you turned its own
 * filter on would tell you nothing about what turning it off would show.
 */
async function listPage(f: ListFilters, scope: Prisma.HomeworkWhereInput) {
  const page = f.page ?? 1;
  const limit = f.limit ?? 12;
  const base = baseWhere(f, scope);
  const withStatus: Prisma.HomeworkWhereInput = {
    ...base,
    ...(dueWindow(f.from, f.to, f.status ?? 'all') ? { dueDate: dueWindow(f.from, f.to, f.status ?? 'all') } : {}),
  };
  const windowOnly = dueWindow(f.from, f.to);

  const [total, rows, scoped, overdue, withAttachment] = await Promise.all([
    prisma.homework.count({ where: withStatus }),
    prisma.homework.findMany({
      where: withStatus,
      include: hwInclude,
      orderBy: ORDER_BY[f.sort ?? 'dueDate_desc'] ?? ORDER_BY.dueDate_desc,
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.homework.count({ where: { ...base, ...(windowOnly ? { dueDate: windowOnly } : {}) } }),
    prisma.homework.count({ where: { ...base, dueDate: dueWindow(f.from, f.to, 'overdue') } }),
    prisma.homework.count({
      where: { ...base, ...(windowOnly ? { dueDate: windowOnly } : {}), NOT: { attachmentUrl: null } },
    }),
  ]);

  return {
    items: await shapeAll(rows),
    pagination: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
    stats: { total: scoped, upcoming: scoped - overdue, overdue, withAttachment },
  };
}

export async function listMyTeacherHomework(userId: string, filters: ListFilters) {
  const myId = await teacherProfileId(userId);
  if (!myId) throw NotFound('Teacher profile not found');
  return listPage(filters, { teacherId: myId });
}

export async function listAllHomework(filters: ListFilters) {
  return listPage(filters, {});
}

export async function listChildHomework(
  userId: string,
  studentId: string,
  from?: string,
  to?: string,
  status: 'all' | 'upcoming' | 'overdue' = 'all',
) {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    include: { parent: true },
  });
  if (!student) throw NotFound('Student not found');
  if (student.parent.userId !== userId) throw Forbidden('This student is not your child');

  const window = dueWindow(from, to, status);
  const rows = await prisma.homework.findMany({
    where: { sectionId: student.sectionId, ...(window ? { dueDate: window } : {}) },
    include: hwInclude,
    orderBy: { dueDate: 'desc' },
  });
  return shapeAll(rows);
}
