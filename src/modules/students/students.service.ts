import { AttendanceStatus, PermissionModule, Prisma, Role, UserStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { hashPassword } from '../../utils/password';
import { publicUrl, replaceFile, deleteFile } from '../../services/storage';
import { AppError, Forbidden, NotFound } from '../../utils/apiResponse';
import { userHasPermission } from '../../utils/permissions';
import { money, round2, toMoneyString, ZERO } from '../../utils/money';
import { summarize, type AttendanceSummary } from '../../utils/attendanceMetrics';
import { pktDay, pktDayString, pktMonthRange } from '../../utils/pktDate';
import type { CreateStudentInput, ListStudentsQuery, UpdateStudentInput } from './students.schema';
import { logAudit } from '../audit/audit.service';

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
  // Staff-child link (fees bill to this teacher's salary) + transport route.
  teacherParent: { include: { user: true } },
  transportAssignment: { include: { route: true } },
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
    // Staff child: their fees are billed to this teacher's salary.
    teacherParent: s.teacherParent
      ? { id: s.teacherParent.id, name: s.teacherParent.user.fullName }
      : null,
    transport: s.transportAssignment
      ? {
          routeId: s.transportAssignment.routeId,
          name: s.transportAssignment.route.name,
          monthlyFee: s.transportAssignment.route.monthlyFee.toFixed(2),
          active: s.transportAssignment.route.active,
        }
      : null,
  };
}

/**
 * Apply the two optional links a student can carry: the staff-parent (whose
 * salary their fees bill to) and their transport route. Both are `undefined` =
 * leave alone, `null` = clear. Returns human-readable timeline entries.
 *
 * The staff-parent link is normally **derived**: if the student's own parent is
 * also a teacher, their fees bill to that teacher's salary — no separate data
 * entry, and the two can never drift apart. An explicit `teacherParentId` is
 * still honoured for the case where the registered parent isn't the teacher.
 */
async function applyStudentLinks(
  studentId: string,
  input: { teacherParentId?: string | null; transportRouteId?: string | null },
  opts: { deriveStaffParent?: boolean } = {},
): Promise<string[]> {
  const changes: string[] = [];

  if (input.teacherParentId !== undefined) {
    if (input.teacherParentId) {
      const t = await prisma.teacherProfile.findUnique({
        where: { id: input.teacherParentId },
        include: { user: true },
      });
      if (!t) throw NotFound('Teacher not found');
      await prisma.student.update({ where: { id: studentId }, data: { teacherParentId: t.id } });
      changes.push(`Marked as staff child of ${t.user.fullName} — fees bill to their salary`);
    } else {
      await prisma.student.update({ where: { id: studentId }, data: { teacherParentId: null } });
      changes.push('Staff-child link removed');
    }
  } else if (opts.deriveStaffParent) {
    // Derive from the parent: is this student's parent also a teacher?
    const s = await prisma.student.findUnique({
      where: { id: studentId },
      select: {
        teacherParentId: true,
        parent: { select: { user: { select: { fullName: true, teacherProfile: { select: { id: true } } } } } },
      },
    });
    const derived = s?.parent.user.teacherProfile?.id ?? null;
    if (s && (s.teacherParentId ?? null) !== derived) {
      await prisma.student.update({ where: { id: studentId }, data: { teacherParentId: derived } });
      changes.push(
        derived
          ? `Parent ${s.parent.user.fullName} is a teacher — this child's fees will bill to their salary`
          : 'Staff-child link removed (parent is no longer a teacher)',
      );
    }
  }

  if (input.transportRouteId !== undefined) {
    if (input.transportRouteId) {
      const r = await prisma.transportRoute.findUnique({ where: { id: input.transportRouteId } });
      if (!r) throw NotFound('Transport route not found');
      await prisma.transportAssignment.upsert({
        where: { studentId },
        create: { studentId, routeId: r.id },
        update: { routeId: r.id },
      });
      changes.push(`Transport route set to ${r.name} (Rs ${r.monthlyFee.toFixed(2)}/month)`);
    } else {
      await prisma.transportAssignment.deleteMany({ where: { studentId } });
      changes.push('Transport route removed');
    }
  }

  return changes;
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

export async function listStudents(query: ListStudentsQuery, actor?: Actor) {
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

  // Attach per-student fee dues — only for callers who may view FEES.
  const canViewFees = actor ? await userHasPermission(actor.userId, actor.role, PermissionModule.FEES, 'view') : false;
  const dues = canViewFees ? await studentDues(students.map((s) => s.id)) : null;

  return students.map((s) => ({
    ...shapeListItem(s),
    fees: dues ? (dues.get(s.id) ?? { outstanding: '0.00', unpaidCount: 0 }) : null,
  }));
}

/** Outstanding balance + count of unsettled challans, per student id. */
async function studentDues(ids: string[]): Promise<Map<string, { outstanding: string; unpaidCount: number }>> {
  const map = new Map<string, { outstanding: string; unpaidCount: number }>();
  if (ids.length === 0) return map;
  const challans = await prisma.feeChallan.findMany({
    where: { studentId: { in: ids } },
    select: {
      studentId: true,
      amount: true,
      staffCovered: true,
      allocations: { where: { payment: { isReversed: false } }, select: { amountApplied: true } },
    },
  });
  const acc = new Map<string, { outstanding: ReturnType<typeof money>; unpaidCount: number }>();
  for (const c of challans) {
    const cash = c.allocations.reduce((sum, a) => sum.plus(a.amountApplied), ZERO);
    const balance = round2(money(c.amount).minus(c.staffCovered).minus(cash));
    if (balance.greaterThan(0)) {
      const cur = acc.get(c.studentId) ?? { outstanding: ZERO, unpaidCount: 0 };
      cur.outstanding = cur.outstanding.plus(balance);
      cur.unpaidCount += 1;
      acc.set(c.studentId, cur);
    }
  }
  for (const [id, v] of acc) map.set(id, { outstanding: toMoneyString(v.outstanding), unpaidCount: v.unpaidCount });
  return map;
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

async function logStudentEvent(
  studentId: string,
  actorOrUserId: Actor | string,
  action: string,
  description: string,
  targetLabel?: string,
  changes?: Record<string, any> | null
) {
  const actorId = typeof actorOrUserId === 'string' ? actorOrUserId : actorOrUserId.userId;
  const actorRole = typeof actorOrUserId === 'string' ? 'ADMIN' : actorOrUserId.role;
  
  const student = await prisma.student.findUnique({ where: { id: studentId }, select: { firstName: true, lastName: true, admissionNo: true } });
  const label = targetLabel || (student ? `${student.firstName} ${student.lastName} (${student.admissionNo})` : `Student #${studentId}`);

  const user = await prisma.user.findUnique({ where: { id: actorId }, select: { fullName: true } });
  await logAudit(null, {
    actorId,
    actorName: user?.fullName ?? 'Admin',
    actorRole,
    action,
    module: 'STUDENTS',
    targetType: 'Student',
    targetId: studentId,
    targetLabel: label,
    details: description,
    changes,
  });
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

  const linkChanges = await applyStudentLinks(createdStudent.id, input, { deriveStaffParent: true });
  if (linkChanges.length > 0) {
    await logStudentEvent(createdStudent.id, actor.userId, 'UPDATED', linkChanges.join(', '));
  }

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

  const changes: Record<string, any> = {};
  const changedLabels: string[] = [];
  let actionType = 'UPDATE';

  if (data.sectionId && data.sectionId !== student.sectionId) {
    const newSection = await prisma.section.findUnique({
      where: { id: data.sectionId },
      include: { class: true },
    });
    if (newSection) {
      const oldSection = student.section;
      const oldLabel = `${oldSection.class.name}-${oldSection.name}`;
      const newLabel = `${newSection.class.name}-${newSection.name}`;
      if (newSection.class.id !== oldSection.class.id) {
        actionType = newSection.class.order > oldSection.class.order ? 'PROMOTED' : 'TRANSFERRED';
      } else {
        actionType = 'TRANSFERRED';
      }
      changes.classSection = { before: oldLabel, after: newLabel };
      changedLabels.push('Class Section');
    }
  }

  if (data.firstName && data.firstName !== student.firstName) {
    changes.firstName = { before: student.firstName, after: data.firstName };
    changedLabels.push('First Name');
  }
  if (data.lastName && data.lastName !== student.lastName) {
    changes.lastName = { before: student.lastName, after: data.lastName };
    changedLabels.push('Last Name');
  }
  if (data.rollNo !== undefined && (data.rollNo ?? null) !== (student.rollNo ?? null)) {
    changes.rollNo = { before: student.rollNo ?? 'None', after: data.rollNo ?? 'None' };
    changedLabels.push('Roll Number');
  }
  if (data.admissionNo && data.admissionNo !== student.admissionNo) {
    changes.admissionNo = { before: student.admissionNo, after: data.admissionNo };
    changedLabels.push('Admission Number');
  }

  // Strict Date comparison (YYYY-MM-DD) to prevent false positive "Date of birth changed"
  const oldDobStr = student.dob ? new Date(student.dob).toISOString().split('T')[0] : null;
  const newDobStr = data.dob ? new Date(data.dob).toISOString().split('T')[0] : null;
  if (data.dob !== undefined && oldDobStr !== newDobStr) {
    changes.dateOfBirth = { before: oldDobStr ?? 'None', after: newDobStr ?? 'None' };
    changedLabels.push('Date of Birth');
  }

  if (data.gender && data.gender !== student.gender) {
    changes.gender = { before: student.gender, after: data.gender };
    changedLabels.push('Gender');
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

  const updatedStudent = await prisma.student.findUnique({
    where: { id },
    include: {
      section: { include: { class: true } },
      parent: { include: { user: true } },
    },
  });

  if (actor && changedLabels.length > 0) {
    const studentName = `${updatedStudent?.firstName ?? student.firstName} ${updatedStudent?.lastName ?? student.lastName}`;
    const desc = `Updated ${changedLabels.length} field${changedLabels.length > 1 ? 's' : ''} (${changedLabels.join(', ')}) for student ${studentName}`;
    
    // Attach guardian metadata for rich UI display
    changes._meta = {
      photoUrl: publicUrl(updatedStudent?.photoUrl),
      guardianName: updatedStudent?.parent?.user.fullName,
      guardianPhone: updatedStudent?.parent?.user.phone,
      classSection: updatedStudent ? `${updatedStudent.section.class.name}-${updatedStudent.section.name}` : undefined,
    };

    await logStudentEvent(
      id,
      actor,
      actionType,
      desc,
      `${studentName} (${updatedStudent?.rollNo || updatedStudent?.admissionNo})`,
      changes
    );
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
      targetType: 'Student',
      targetId: studentId,
    },
    orderBy: {
      timestamp: 'desc',
    },
  });

  return logs.map((log) => {
    return {
      id: log.id,
      action: log.action,
      description: log.details,
      createdAt: log.timestamp,
      actorName: log.actorName,
      actorRole: log.actorRole,
      changes: log.changes,
    };
  });
}

/**
 * Hard-delete a student and **every record tied to them** — attendance, fee
 * challans (+ line items + payment allocations) and payments. ADMIN-only,
 * irreversible. A student is never an "actor" anywhere, so nothing else in the
 * system references them; all the FKs above are `onDelete: Cascade`, but we
 * delete explicitly (inside one transaction) so the outcome is deterministic
 * and independent of the DB's cascade configuration.
 */
export async function purgeStudent(actor: Actor, id: string) {
  const student = await prisma.student.findUnique({
    where: { id },
    include: { section: { include: { class: true } } },
  });
  if (!student) throw NotFound('Student not found');

  const name = `${student.firstName} ${student.lastName}`;

  await prisma.$transaction(async (tx) => {
    // Fee ledger: allocations → items → payments → challans.
    await tx.feePaymentAllocation.deleteMany({ where: { challan: { studentId: id } } });
    await tx.feeChallanItem.deleteMany({ where: { challan: { studentId: id } } });
    await tx.feePayment.deleteMany({ where: { studentId: id } });
    await tx.feeChallan.deleteMany({ where: { studentId: id } });
    // Attendance history + transport assignment.
    await tx.studentAttendance.deleteMany({ where: { studentId: id } });
    await tx.transportAssignment.deleteMany({ where: { studentId: id } });
    // The student themselves.
    await tx.student.delete({ where: { id } });
    const actorUser = await tx.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });
    const rawClassName = student.section.class.name.trim();
    const cleanClassName = rawClassName.toLowerCase().startsWith('class') ? rawClassName : `Class ${rawClassName}`;
    const sectionLabel = student.section.name ? `${cleanClassName}-${student.section.name}` : cleanClassName;
    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        actorName: actorUser?.fullName ?? 'Admin',
        actorRole: actor.role,
        action: 'DELETE',
        module: 'STUDENTS',
        targetType: 'Student',
        targetId: id,
        targetLabel: `${name} (${student.admissionNo})`,
        details: `Admin purged student record for ${name} (${student.admissionNo}) from ${sectionLabel}`,
      },
    });
    // Several sequential deletes against a remote DB — allow ample time.
  }, { timeout: 60_000, maxWait: 20_000 });

  // Best-effort: remove the profile photo from file storage.
  if (student.photoUrl) await deleteFile(student.photoUrl).catch(() => undefined);

  return { id, name, deleted: true };
}
