import { AttendanceStatus, PermissionModule, Prisma, Role, UserStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { hashPassword } from '../../utils/password';
import { publicUrl, replaceFile } from '../../services/storage';
import { AppError, Forbidden, NotFound } from '../../utils/apiResponse';
import { userHasPermission } from '../../utils/permissions';
import { summarize, type AttendanceSummary } from '../../utils/attendanceMetrics';
import { pktDay, pktDayString, pktMonthRange } from '../../utils/pktDate';
import type { CreateStudentInput, ListStudentsQuery, UpdateStudentInput } from './students.schema';

export interface Actor {
  userId: string;
  role: Role;
}

interface AttendanceSnapshot {
  year: number;
  month: number;
  days: Record<string, AttendanceStatus>;
  summary: AttendanceSummary;
}

const studentInclude = {
  section: { include: { class: true } },
  parent: { include: { user: true } },
} satisfies Prisma.StudentInclude;

type StudentWithRels = Prisma.StudentGetPayload<{ include: typeof studentInclude }>;

function shapeListItem(s: StudentWithRels) {
  return {
    id: s.id,
    admissionNo: s.admissionNo,
    rollNo: s.rollNo,
    firstName: s.firstName,
    lastName: s.lastName,
    name: `${s.firstName} ${s.lastName}`,
    gender: s.gender,
    status: s.status,
    dob: s.dob,
    admissionDate: s.admissionDate,
    photoUrl: publicUrl(s.photoUrl),
    section: { id: s.section.id, name: s.section.name },
    class: { id: s.section.class.id, name: s.section.class.name },
    parent: { id: s.parent.id, name: s.parent.user.fullName, phone: s.parent.user.phone },
  };
}

function shapeDetail(s: StudentWithRels) {
  return {
    ...shapeListItem(s),
    parent: {
      id: s.parent.id,
      name: s.parent.user.fullName,
      cnic: s.parent.user.cnic,
      phone: s.parent.user.phone,
    },
    // Current-month attendance; null when the viewer lacks ATTENDANCE view.
    attendance: null as AttendanceSnapshot | null,
    // Populated in Phase 5:
    fees: [] as unknown[],
  };
}

/** The student's attendance for a PKT month (day map + summary); defaults to the current month. */
async function attendanceSnapshot(studentId: string, year?: number, month?: number): Promise<AttendanceSnapshot> {
  const now = pktDay();
  year = year ?? now.getUTCFullYear();
  month = month ?? now.getUTCMonth() + 1;
  const { start, endExclusive } = pktMonthRange(year, month);

  const marks = await prisma.studentAttendance.findMany({
    where: { studentId, date: { gte: start, lt: endExclusive } },
    orderBy: { date: 'asc' },
  });
  const days: Record<string, AttendanceStatus> = {};
  for (const m of marks) days[pktDayString(m.date)] = m.status;
  return { year, month, days, summary: summarize(marks.map((m) => m.status)) };
}

async function loadStudentOr404(id: string): Promise<StudentWithRels> {
  const student = await prisma.student.findUnique({ where: { id }, include: studentInclude });
  if (!student) throw NotFound('Student not found');
  return student;
}

async function assertAdmissionFree(admissionNo: string, exceptId?: string) {
  const existing = await prisma.student.findUnique({ where: { admissionNo } });
  if (existing && existing.id !== exceptId) {
    throw new AppError('A student with this admission number already exists', 409, 'ADMISSION_NO_TAKEN');
  }
}

async function assertRollNoFree(sectionId: string, rollNo: string, exceptId?: string) {
  const existing = await prisma.student.findFirst({ where: { sectionId, rollNo } });
  if (existing && existing.id !== exceptId) {
    throw new AppError('This roll number is already used in the target section', 409, 'ROLL_NO_TAKEN');
  }
}

export async function listStudents(query: ListStudentsQuery) {
  const students = await prisma.student.findMany({
    where: {
      status: query.status,
      sectionId: query.sectionId,
      ...(query.classId ? { section: { classId: query.classId } } : {}),
      ...(query.search
        ? {
            OR: [
              { firstName: { contains: query.search, mode: 'insensitive' } },
              { lastName: { contains: query.search, mode: 'insensitive' } },
              { admissionNo: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    include: studentInclude,
    orderBy: [{ section: { class: { order: 'asc' } } }, { firstName: 'asc' }],
  });
  return students.map(shapeListItem);
}

export async function getStudent(id: string, actor?: Actor) {
  const detail = shapeDetail(await loadStudentOr404(id));
  if (actor && (await userHasPermission(actor.userId, actor.role, PermissionModule.ATTENDANCE, 'view'))) {
    detail.attendance = await attendanceSnapshot(id);
  }
  return detail;
}

/** Month-scoped attendance snapshot for the profile view's month picker. */
export async function getStudentAttendance(id: string, actor: Actor, year?: number, month?: number) {
  await loadStudentOr404(id);
  if (!(await userHasPermission(actor.userId, actor.role, PermissionModule.ATTENDANCE, 'view'))) {
    throw Forbidden('You do not have permission to view attendance');
  }
  return attendanceSnapshot(id, year, month);
}

async function logStudentEvent(studentId: string, actorId: string, action: string, description: string) {
  try {
    await prisma.auditLog.create({
      data: {
        userId: actorId,
        action,
        entity: 'Student',
        entityId: studentId,
        metadata: { description },
      },
    });
  } catch (err) {
    console.error('Failed to write student audit log:', err);
  }
}

export async function createStudent(actor: Actor, input: CreateStudentInput) {
  const section = await prisma.section.findUnique({ where: { id: input.sectionId }, include: { class: true } });
  if (!section) throw NotFound('Section not found');

  await assertAdmissionFree(input.admissionNo);
  if (input.rollNo) await assertRollNoFree(input.sectionId, input.rollNo);

  const baseData = {
    admissionNo: input.admissionNo,
    rollNo: input.rollNo ?? null,
    firstName: input.firstName,
    lastName: input.lastName,
    gender: input.gender,
    dob: input.dob ?? null,
    admissionDate: input.admissionDate,
    sectionId: input.sectionId,
  };

  let createdStudent: any = null;

  // Case 1: link to an existing parent.
  if (input.parentId) {
    const parent = await prisma.parentProfile.findUnique({ where: { id: input.parentId } });
    if (!parent) throw NotFound('Parent not found');
    createdStudent = await prisma.student.create({ data: { ...baseData, parentId: input.parentId } });
  } else {
    // Case 2: create the parent + student atomically (or link to existing user).
    const p = input.parent!;
    const existingUser = await prisma.user.findUnique({
      where: { cnic: p.cnic },
      include: { parentProfile: true },
    });

    if (existingUser) {
      if (existingUser.parentProfile) {
        createdStudent = await prisma.student.create({
          data: { ...baseData, parentId: existingUser.parentProfile.id },
        });
      } else {
        const updatedUser = await prisma.user.update({
          where: { id: existingUser.id },
          data: {
            parentProfile: {
              create: { occupation: p.occupation ?? null, address: p.address ?? null },
            },
          },
          include: { parentProfile: true },
        });

        createdStudent = await prisma.student.create({
          data: { ...baseData, parentId: updatedUser.parentProfile!.id },
        });
      }
    } else {
      const passwordHash = await hashPassword(p.password);
      createdStudent = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            cnic: p.cnic,
            fullName: p.fullName,
            phone: p.phone ?? null,
            passwordHash,
            role: Role.PARENT,
            createdById: actor.userId,
            parentProfile: { create: { occupation: p.occupation ?? null, address: p.address ?? null } },
          },
          include: { parentProfile: true },
        });
        return tx.student.create({ data: { ...baseData, parentId: user.parentProfile!.id } });
      });
    }
  }

  const classDisplay = section ? `${section.class.name} (Section ${section.name})` : '';
  await logStudentEvent(createdStudent.id, actor.userId, 'ENROLLED', `Student enrolled in ${classDisplay}`);

  return getStudent(createdStudent.id, actor);
}

export async function updateStudent(id: string, data: UpdateStudentInput, actor?: Actor) {
  const student = await prisma.student.findUnique({
    where: { id },
    include: { section: { include: { class: true } } },
  });
  if (!student) throw NotFound('Student not found');

  const targetSectionId = data.sectionId ?? student.sectionId;
  if (data.sectionId && data.sectionId !== student.sectionId) {
    const section = await prisma.section.findUnique({ where: { id: data.sectionId } });
    if (!section) throw NotFound('Target section not found');
  }
  if (data.admissionNo && data.admissionNo !== student.admissionNo) {
    await assertAdmissionFree(data.admissionNo, id);
  }
  let resolvedParentId = data.parentId;
  if (data.parentId && data.parentId !== student.parentId) {
    let parent = await prisma.parentProfile.findUnique({ where: { id: data.parentId } });
    if (!parent) {
      const user = await prisma.user.findUnique({
        where: { id: data.parentId },
        include: { parentProfile: true },
      });
      if (!user) throw NotFound('Parent not found');
      if (user.parentProfile) {
        parent = user.parentProfile;
      } else {
        parent = await prisma.parentProfile.create({
          data: {
            userId: user.id,
            occupation: 'Teacher',
          },
        });
      }
    }
    resolvedParentId = parent.id;
  }
  // roll number must stay unique within its (possibly new) section
  const nextRollNo = data.rollNo === undefined ? student.rollNo : data.rollNo;
  if (nextRollNo && (data.rollNo !== undefined || data.sectionId)) {
    await assertRollNoFree(targetSectionId, nextRollNo, id);
  }

  const changes: string[] = [];
  let actionType = 'UPDATED';

  if (data.sectionId && data.sectionId !== student.sectionId) {
    const newSection = await prisma.section.findUnique({
      where: { id: data.sectionId },
      include: { class: true },
    });
    if (newSection) {
      const oldSection = student.section;
      if (newSection.class.id !== oldSection.class.id) {
        if (newSection.class.order > oldSection.class.order) {
          actionType = 'PROMOTED';
          changes.push(`Promoted from ${oldSection.class.name} to ${newSection.class.name} (Section ${newSection.name})`);
        } else {
          actionType = 'TRANSFERRED';
          changes.push(`Transferred from ${oldSection.class.name} to ${newSection.class.name} (Section ${newSection.name})`);
        }
      } else {
        actionType = 'TRANSFERRED';
        changes.push(`Moved from Section ${oldSection.name} to Section ${newSection.name} in ${oldSection.class.name}`);
      }
    }
  }

  if (data.firstName && data.firstName !== student.firstName) {
    changes.push(`First name changed from '${student.firstName}' to '${data.firstName}'`);
  }
  if (data.lastName && data.lastName !== student.lastName) {
    changes.push(`Last name changed from '${student.lastName}' to '${data.lastName}'`);
  }
  if (data.rollNo !== undefined && data.rollNo !== student.rollNo) {
    changes.push(`Roll number changed from ${student.rollNo ?? 'none'} to ${data.rollNo ?? 'none'}`);
  }
  if (data.admissionNo && data.admissionNo !== student.admissionNo) {
    changes.push(`Admission number changed from ${student.admissionNo} to ${data.admissionNo}`);
  }
  if (data.dob !== undefined && data.dob !== student.dob) {
    changes.push(`Date of birth changed`);
  }
  if (data.gender && data.gender !== student.gender) {
    changes.push(`Gender changed from ${student.gender} to ${data.gender}`);
  }
  if (resolvedParentId && resolvedParentId !== student.parentId) {
    changes.push(`Parent link updated`);
  }

  await prisma.student.update({
    where: { id },
    data: {
      admissionNo: data.admissionNo ?? undefined,
      rollNo: data.rollNo === undefined ? undefined : data.rollNo,
      firstName: data.firstName ?? undefined,
      lastName: data.lastName ?? undefined,
      gender: data.gender ?? undefined,
      dob: data.dob === undefined ? undefined : data.dob,
      admissionDate: data.admissionDate ?? undefined,
      sectionId: data.sectionId ?? undefined,
      parentId: resolvedParentId ?? undefined,
    },
  });

  if (actor && changes.length > 0) {
    await logStudentEvent(id, actor.userId, actionType, changes.join(', '));
  }

  return getStudent(id, actor);
}

export async function setStatus(id: string, status: UserStatus, actor?: Actor) {
  const student = await prisma.student.findUnique({ where: { id } });
  if (!student) throw NotFound('Student not found');
  await prisma.student.update({ where: { id }, data: { status } });
  if (actor) {
    const desc = status === 'ACTIVE' ? 'Student account activated.' : 'Student account deactivated.';
    await logStudentEvent(id, actor.userId, 'STATUS_CHANGE', desc);
  }
  return getStudent(id, actor);
}

export async function setPhoto(id: string, buffer: Buffer, originalName: string, contentType: string, actor?: Actor) {
  const student = await prisma.student.findUnique({ where: { id } });
  if (!student) throw NotFound('Student not found');
  const newPath = await replaceFile(student.photoUrl, buffer, originalName, `/students/${id}`, contentType);
  await prisma.student.update({ where: { id }, data: { photoUrl: newPath } });
  if (actor) {
    await logStudentEvent(id, actor.userId, 'UPDATED', 'Student photo updated.');
  }
  return getStudent(id, actor);
}

export async function getStudentAuditLogs(studentId: string, actor: Actor) {
  await loadStudentOr404(studentId);
  const logs = await prisma.auditLog.findMany({
    where: {
      entity: 'Student',
      entityId: studentId,
    },
    include: {
      user: {
        select: {
          fullName: true,
          role: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  return logs.map((log) => {
    const meta: any = log.metadata;
    return {
      id: log.id,
      action: log.action,
      description: meta?.description ?? '',
      createdAt: log.createdAt,
      actorName: log.user.fullName,
      actorRole: log.user.role,
    };
  });
}
