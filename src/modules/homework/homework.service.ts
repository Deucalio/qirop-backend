import { Prisma, PermissionModule, Role } from '@prisma/client';
import type { Response } from 'express';
import { prisma } from '../../config/prisma';
import { userHasPermission } from '../../utils/permissions';
import * as storage from '../../services/storage';
import { parsePktDay } from '../../utils/pktDate';
import { AppError, Forbidden, NotFound } from '../../utils/apiResponse';
import type { CreateHomeworkInput, UpdateHomeworkInput } from './homework.schema';

const HOMEWORK = PermissionModule.HOMEWORK;

export interface Actor {
  userId: string;
  role: Role;
}

interface Filters {
  classId?: string;
  sectionId?: string;
  subjectId?: string;
  from?: string;
  to?: string;
}

const hwInclude = {
  section: { include: { class: true } },
  subject: true,
  teacher: { include: { user: true } },
} satisfies Prisma.HomeworkInclude;

type HwWithRels = Prisma.HomeworkGetPayload<{ include: typeof hwInclude }>;

function shape(hw: HwWithRels) {
  return {
    id: hw.id,
    sectionId: hw.sectionId,
    sectionName: hw.section.name,
    classId: hw.section.classId,
    className: hw.section.class.name,
    subjectId: hw.subjectId,
    subjectName: hw.subject.name,
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

function dueDateRange(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  const range: Prisma.DateTimeFilter = {};
  if (from) range.gte = parsePktDay(from);
  if (to) range.lte = parsePktDay(to);
  return range;
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
    const path = await storage.uploadFile(file.buffer, file.originalname, `/homework/${hw.id}`, file.mimetype);
    await prisma.homework.update({ where: { id: hw.id }, data: { attachmentUrl: path } });
  }
  return shape(await loadHomework(hw.id));
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
    attachmentUrl = await storage.replaceFile(hw.attachmentUrl, file.buffer, file.originalname, `/homework/${id}`, file.mimetype);
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
  return shape(await loadHomework(id));
}

export async function deleteHomework(actor: Actor, id: string) {
  const hw = await loadHomework(id);
  await assertCanManage(actor, hw);
  if (hw.attachmentUrl) await storage.deleteFile(hw.attachmentUrl);
  await prisma.homework.delete({ where: { id } });
}

export async function getHomework(actor: Actor, id: string) {
  const hw = await loadHomework(id);
  await assertCanView(actor, hw);
  return shape(hw);
}

export async function downloadAttachment(actor: Actor, id: string, res: Response): Promise<void> {
  const hw = await loadHomework(id);
  await assertCanView(actor, hw);
  if (!hw.attachmentUrl) throw NotFound('This homework has no attachment');
  await storage.proxyDownload(hw.attachmentUrl, res);
}

export async function listMyTeacherHomework(userId: string, filters: Filters) {
  const myId = await teacherProfileId(userId);
  if (!myId) throw NotFound('Teacher profile not found');
  const rows = await prisma.homework.findMany({
    where: {
      teacherId: myId,
      sectionId: filters.sectionId,
      subjectId: filters.subjectId,
      dueDate: dueDateRange(filters.from, filters.to),
    },
    include: hwInclude,
    orderBy: { dueDate: 'desc' },
  });
  return rows.map(shape);
}

export async function listAllHomework(filters: Filters) {
  const rows = await prisma.homework.findMany({
    where: {
      sectionId: filters.sectionId,
      subjectId: filters.subjectId,
      ...(filters.classId ? { section: { classId: filters.classId } } : {}),
      dueDate: dueDateRange(filters.from, filters.to),
    },
    include: hwInclude,
    orderBy: { dueDate: 'desc' },
  });
  return rows.map(shape);
}

export async function listChildHomework(userId: string, studentId: string, from?: string, to?: string) {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    include: { parent: true },
  });
  if (!student) throw NotFound('Student not found');
  if (student.parent.userId !== userId) throw Forbidden('This student is not your child');

  const rows = await prisma.homework.findMany({
    where: { sectionId: student.sectionId, dueDate: dueDateRange(from, to) },
    include: hwInclude,
    orderBy: { dueDate: 'desc' },
  });
  return rows.map(shape);
}
