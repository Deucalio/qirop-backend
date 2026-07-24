import { AttendanceStatus, MarkingType, PermissionModule, Prisma, Role, UserStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { hashPassword } from '../../utils/password';
import { publicUrl, replaceFile, deleteFile } from '../../services/storage';
import { AppError, Forbidden, NotFound } from '../../utils/apiResponse';
import { userHasPermission } from '../../utils/permissions';
import { summarize } from '../../utils/attendanceMetrics';
import { pktDay, pktDayString, pktMonthRange } from '../../utils/pktDate';
import type { CreateTeacherInput, ListTeachersQuery, UpdateTeacherInput } from './teachers.schema';

export interface Actor {
  userId: string;
  role: Role;
}

const teacherInclude = {
  user: {
    include: {
      parentProfile: {
        include: {
          students: {
            include: {
              section: {
                include: {
                  class: true,
                },
              },
            },
          },
        },
      },
    },
  },
  teachingAssignments: { include: { section: { include: { class: true } }, subject: true } },
  classTeacherSections: { include: { class: true } },
  qualifications: { orderBy: { level: 'asc' } },
  // Own commute route — its fee is deducted from this teacher's salary.
  transportAssignment: { include: { route: true } },
} satisfies Prisma.TeacherProfileInclude;

type TeacherWithRels = Prisma.TeacherProfileGetPayload<{ include: typeof teacherInclude }>;
type TeachingRow = TeacherWithRels['teachingAssignments'][number];
type SectionRow = TeacherWithRels['classTeacherSections'][number];

function shapeTeaching(ta: TeachingRow) {
  return {
    id: ta.id,
    section: { id: ta.section.id, name: ta.section.name, classId: ta.section.classId, className: ta.section.class.name },
    subject: { id: ta.subject.id, name: ta.subject.name, colorHex: ta.subject.colorHex },
  };
}

function shapeClassTeacherSection(s: SectionRow) {
  return { id: s.id, name: s.name, classId: s.classId, className: s.class.name };
}

/** Shape a teacher for a detail view. `salary` is included ONLY when allowed. */
function shapeTeacher(profile: TeacherWithRels, includeSalary: boolean) {
  const parentProfile = (profile.user as any).parentProfile;
  const children = parentProfile?.students.map((s: any) => ({
    id: s.id,
    name: `${s.firstName} ${s.lastName}`,
    admissionNo: s.admissionNo,
    className: s.section.class.name,
    sectionName: s.section.name,
    status: s.status,
  })) || [];

  return {
    id: profile.id,
    userId: profile.userId,
    cnic: profile.user.cnic,
    fullName: profile.user.fullName,
    phone: profile.user.phone,
    avatarUrl: publicUrl(profile.user.avatarUrl),
    employeeId: profile.employeeId,
    gender: profile.gender,
    qualification: profile.qualification,
    address: profile.address,
    joiningDate: profile.joiningDate,
    status: profile.status,
    fatherName: profile.fatherName,
    parentCnic: profile.parentCnic,
    ...(includeSalary ? { salary: profile.salary.toString() } : {}),
    qualifications: profile.qualifications.map((q) => ({
      level: q.level,
      institution: q.institution,
      passingYear: q.passingYear,
      marks: q.marks,
      grade: q.grade,
      markingType: q.markingType,
      obtainedMarks: q.obtainedMarks !== null ? Number(q.obtainedMarks) : null,
      totalMarks: q.totalMarks !== null ? Number(q.totalMarks) : null,
    })),
    teachingAssignments: profile.teachingAssignments.map(shapeTeaching),
    classTeacherSections: profile.classTeacherSections.map(shapeClassTeacherSection),
    children,
    transport: profile.transportAssignment
      ? {
          routeId: profile.transportAssignment.routeId,
          name: profile.transportAssignment.route.name,
          monthlyFee: profile.transportAssignment.route.monthlyFee.toFixed(2),
          active: profile.transportAssignment.route.active,
        }
      : null,
  };
}

/** Set/clear a teacher's own commute route. `undefined` = leave alone, `null` = clear. */
async function applyTeacherTransport(teacherId: string, routeId: string | null | undefined): Promise<void> {
  if (routeId === undefined) return;
  if (routeId) {
    const r = await prisma.transportRoute.findUnique({ where: { id: routeId } });
    if (!r) throw NotFound('Transport route not found');
    await prisma.transportAssignment.upsert({
      where: { teacherId },
      create: { teacherId, routeId: r.id },
      update: { routeId: r.id },
    });
  } else {
    await prisma.transportAssignment.deleteMany({ where: { teacherId } });
  }
}

async function loadTeacherOr404(id: string): Promise<TeacherWithRels> {
  const profile = await prisma.teacherProfile.findUnique({ where: { id }, include: teacherInclude });
  if (!profile) throw NotFound('Teacher not found');
  return profile;
}

export async function listTeachers(query: ListTeachersQuery) {
  const profiles = await prisma.teacherProfile.findMany({
    where: {
      status: query.status,
      ...(query.search
        ? {
            OR: [
              { user: { fullName: { contains: query.search, mode: 'insensitive' } } },
              { employeeId: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    include: { user: true, _count: { select: { teachingAssignments: true, classTeacherSections: true } } },
    orderBy: { user: { fullName: 'asc' } },
  });
  return profiles.map((p) => ({
    id: p.id,
    userId: p.userId,
    fullName: p.user.fullName,
    cnic: p.user.cnic,
    employeeId: p.employeeId,
    phone: p.user.phone,
    status: p.status,
    subjectCount: p._count.teachingAssignments,
    classTeacherCount: p._count.classTeacherSections,
  }));
}

export async function getTeacher(id: string, includeSalary: boolean) {
  const profile = await loadTeacherOr404(id);
  return shapeTeacher(profile, includeSalary);
}

/** Teacher self-view — NEVER includes salary. */
export async function getMeTeacher(userId: string) {
  const profile = await prisma.teacherProfile.findUnique({ where: { userId }, include: teacherInclude });
  if (!profile) throw NotFound('Teacher profile not found');
  return shapeTeacher(profile, false);
}

export async function getTeacherAssignments(id: string) {
  const profile = await loadTeacherOr404(id);
  return {
    teachingAssignments: profile.teachingAssignments.map(shapeTeaching),
    classTeacherSections: profile.classTeacherSections.map(shapeClassTeacherSection),
  };
}

export async function createTeacher(actorId: string, input: CreateTeacherInput) {
  const cnicTaken = await prisma.user.findUnique({ where: { cnic: input.cnic } });
  if (cnicTaken) throw new AppError('A user with this CNIC already exists', 409, 'CNIC_TAKEN');
  const empTaken = await prisma.teacherProfile.findUnique({ where: { employeeId: input.employeeId } });
  if (empTaken) throw new AppError('A teacher with this employee ID already exists', 409, 'EMPLOYEE_ID_TAKEN');

  const passwordHash = await hashPassword(input.password);

  // Shape qualification rows for Prisma create
  const qualRows = (input.qualifications ?? []).map((q) => ({
    level: q.level,
    institution: q.institution,
    passingYear: q.passingYear,
    marks: q.marks ?? null,
    grade: q.grade ?? null,
    markingType: q.markingType ?? MarkingType.TEXT,
    obtainedMarks: q.obtainedMarks != null ? new Prisma.Decimal(q.obtainedMarks) : null,
    totalMarks: q.totalMarks != null ? new Prisma.Decimal(q.totalMarks) : null,
  }));

  const user = await prisma.user.create({
    data: {
      cnic: input.cnic,
      fullName: input.fullName,
      phone: input.phone ?? null,
      passwordHash,
      role: Role.TEACHER,
      createdById: actorId,
      teacherProfile: {
        create: {
          employeeId: input.employeeId,
          gender: input.gender,
          qualification: input.qualification ?? null,
          address: input.address ?? null,
          joiningDate: input.joiningDate,
          salary: new Prisma.Decimal(input.salary),
          status: UserStatus.ACTIVE,
          fatherName: input.fatherName,
          parentCnic: input.parentCnic || null,
          ...(qualRows.length > 0 ? { qualifications: { create: qualRows } } : {}),
        },
      },
    },
    include: { teacherProfile: true },
  });
  await applyTeacherTransport(user.teacherProfile!.id, input.transportRouteId);
  return getTeacher(user.teacherProfile!.id, true);
}

export async function updateTeacher(id: string, data: UpdateTeacherInput) {
  const profile = await prisma.teacherProfile.findUnique({ where: { id } });
  if (!profile) throw NotFound('Teacher not found');

  if (data.employeeId && data.employeeId !== profile.employeeId) {
    const clash = await prisma.teacherProfile.findUnique({ where: { employeeId: data.employeeId } });
    if (clash) throw new AppError('A teacher with this employee ID already exists', 409, 'EMPLOYEE_ID_TAKEN');
  }

  // Shape qualification rows for Prisma create (replace-all)
  const qualRows = data.qualifications?.map((q) => ({
    level: q.level,
    institution: q.institution,
    passingYear: q.passingYear,
    marks: q.marks ?? null,
    grade: q.grade ?? null,
    markingType: q.markingType ?? MarkingType.TEXT,
    obtainedMarks: q.obtainedMarks != null ? new Prisma.Decimal(q.obtainedMarks) : null,
    totalMarks: q.totalMarks != null ? new Prisma.Decimal(q.totalMarks) : null,
  }));

  await prisma.teacherProfile.update({
    where: { id },
    data: {
      employeeId: data.employeeId ?? undefined,
      gender: data.gender ?? undefined,
      qualification: data.qualification === undefined ? undefined : data.qualification,
      address: data.address === undefined ? undefined : data.address,
      joiningDate: data.joiningDate ?? undefined,
      salary: data.salary === undefined ? undefined : new Prisma.Decimal(data.salary),
      fatherName: data.fatherName ?? undefined,
      parentCnic: data.parentCnic === undefined ? undefined : (data.parentCnic || null),
      // Omitted = untouched; sent = the full new set (replace-all).
      ...(qualRows !== undefined
        ? { qualifications: { deleteMany: {}, create: qualRows } }
        : {}),
      user: {
        update: {
          fullName: data.fullName ?? undefined,
          phone: data.phone === undefined ? undefined : data.phone,
        },
      },
    },
  });
  await applyTeacherTransport(id, data.transportRouteId);
  return getTeacher(id, true);
}

export async function setTeacherStatus(id: string, status: UserStatus, force: boolean) {
  const profile = await loadTeacherOr404(id);

  if (status !== UserStatus.ACTIVE) {
    const hasAssignments = profile.teachingAssignments.length + profile.classTeacherSections.length > 0;
    if (hasAssignments && !force) {
      throw new AppError(
        'This teacher still holds assignments. Reassign them, or pass force=true to deactivate anyway.',
        409,
        'TEACHER_HAS_ASSIGNMENTS',
        {
          teachingAssignments: profile.teachingAssignments.map(shapeTeaching),
          classTeacherSections: profile.classTeacherSections.map(shapeClassTeacherSection),
        },
      );
    }
  }

  await prisma.$transaction([
    prisma.teacherProfile.update({ where: { id }, data: { status } }),
    prisma.user.update({ where: { id: profile.userId }, data: { status } }),
  ]);
  return getTeacher(id, true);
}

export async function resetPassword(id: string, newPassword: string) {
  const profile = await prisma.teacherProfile.findUnique({ where: { id } });
  if (!profile) throw NotFound('Teacher not found');
  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: profile.userId }, data: { passwordHash } });
}

export async function setPhoto(id: string, buffer: Buffer, originalName: string, contentType: string) {
  const profile = await prisma.teacherProfile.findUnique({ where: { id }, include: { user: true } });
  if (!profile) throw NotFound('Teacher not found');
  const newPath = await replaceFile(profile.user.avatarUrl, buffer, originalName, `/teachers/${id}`, contentType);
  await prisma.user.update({ where: { id: profile.userId }, data: { avatarUrl: newPath } });
  return getTeacher(id, true);
}

/**
 * Month-scoped attendance snapshot (day map + check-in times + summary) for the
 * admin profile view. Requires ATTENDANCE view on top of the route's STAFF view.
 */
export async function getTeacherAttendance(id: string, actor: Actor, year?: number, month?: number) {
  const profile = await prisma.teacherProfile.findUnique({ where: { id } });
  if (!profile) throw NotFound('Teacher not found');
  if (!(await userHasPermission(actor.userId, actor.role, PermissionModule.ATTENDANCE, 'view'))) {
    throw Forbidden('You do not have permission to view attendance');
  }

  const now = pktDay();
  year = year ?? now.getUTCFullYear();
  month = month ?? now.getUTCMonth() + 1;
  const { start, endExclusive } = pktMonthRange(year, month);

  const marks = await prisma.teacherAttendance.findMany({
    where: { teacherId: id, date: { gte: start, lt: endExclusive } },
    orderBy: { date: 'asc' },
  });
  const days: Record<string, AttendanceStatus> = {};
  const checkInTimes: Record<string, string | null> = {};
  for (const m of marks) {
    const key = pktDayString(m.date);
    days[key] = m.status;
    checkInTimes[key] = m.checkInTime ? m.checkInTime.toISOString() : null;
  }

  // Calculate student attendance stats class-wise (sections the teacher teaches or is class teacher of)
  const sections = await prisma.section.findMany({
    where: {
      OR: [
        { classTeacherId: id },
        { teachingAssignments: { some: { teacherId: id } } },
      ],
    },
    include: {
      class: true,
      teachingAssignments: { where: { teacherId: id }, include: { subject: true } },
    },
  });

  const classAttendance = [];
  const today = pktDay();

  for (const sec of sections) {
    const isClassTeacher = sec.classTeacherId === id;
    const subjects = sec.teachingAssignments.map((ta) => ta.subject.name);

    const studentCount = await prisma.student.count({
      where: { sectionId: sec.id, status: UserStatus.ACTIVE },
    });

    const studentMarks = await prisma.studentAttendance.findMany({
      where: { sectionId: sec.id, date: { gte: start, lt: endExclusive } },
    });

    const total = studentMarks.length;
    const present = studentMarks.filter((m) => m.status === 'PRESENT' || m.status === 'LATE').length;
    const rate = total > 0 ? Math.round((present / total) * 100) : null;

    const todayMarks = await prisma.studentAttendance.count({
      where: { sectionId: sec.id, date: today },
    });
    const markedToday = todayMarks > 0;

    classAttendance.push({
      sectionId: sec.id,
      className: sec.class.name,
      sectionName: sec.name,
      isDefaultSection: sec.isDefault,
      isClassTeacher,
      subjects,
      studentCount,
      attendanceRate: rate,
      markedToday,
    });
  }

  return {
    year,
    month,
    days,
    checkInTimes,
    summary: summarize(marks.map((m) => m.status)),
    classAttendance,
  };
}

export async function linkStudentToTeacher(teacherId: string, studentId: string) {
  const profile = await prisma.teacherProfile.findUnique({
    where: { id: teacherId },
    include: { user: { include: { parentProfile: true } } },
  });

  if (!profile) throw NotFound('Teacher not found');

  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) throw NotFound('Student not found');

  let parentProfileId = profile.user.parentProfile?.id;

  if (!parentProfileId) {
    const updatedUser = await prisma.user.update({
      where: { id: profile.userId },
      data: {
        parentProfile: {
          create: { address: profile.address, occupation: 'Teacher' },
        },
      },
      include: { parentProfile: true },
    });
    parentProfileId = updatedUser.parentProfile!.id;
  }

  await prisma.student.update({
    where: { id: studentId },
    data: { parentId: parentProfileId },
  });

  return getTeacher(teacherId, true);
}

/**
 * Hard-delete a teacher and **every record tied to them** — their login,
 * teaching assignments, homework, their own attendance & per-period marks,
 * salary slips and qualifications. ADMIN-only, irreversible.
 *
 * Records that merely *reference the teacher as an actor* (student attendance
 * they marked, payments they received) belong to other people, so those are
 * **re-attributed to the deleting admin** rather than destroyed. Links that can
 * simply drop (class-teacher of a section, staff-parent of a student, staff-billed
 * challans) are set to null.
 */
export async function purgeTeacher(actor: Actor, id: string) {
  const teacher = await prisma.teacherProfile.findUnique({
    where: { id },
    include: { user: true, homework: { select: { attachmentUrl: true } } },
  });
  if (!teacher) throw NotFound('Teacher not found');

  const userId = teacher.userId;
  const name = teacher.user.fullName;
  const attachments = teacher.homework.map((h) => h.attachmentUrl).filter((u): u is string => !!u);
  const avatarUrl = teacher.user.avatarUrl;

  await prisma.$transaction(async (tx) => {
    // 1. Re-attribute actor references (Restrict FKs) to the acting admin so the
    //    other party's record survives.
    await tx.studentAttendance.updateMany({ where: { markedById: userId }, data: { markedById: actor.userId } });
    await tx.teacherPeriodAttendance.updateMany({ where: { markedById: userId }, data: { markedById: actor.userId } });
    await tx.feePayment.updateMany({ where: { receivedById: userId }, data: { receivedById: actor.userId } });
    await tx.salarySlip.updateMany({ where: { generatedById: userId }, data: { generatedById: actor.userId } });
    await tx.expense.updateMany({ where: { recordedById: userId }, data: { recordedById: actor.userId } });

    // 2. Drop optional links back to this teacher.
    await tx.section.updateMany({ where: { classTeacherId: id }, data: { classTeacherId: null } });
    await tx.student.updateMany({ where: { teacherParentId: id }, data: { teacherParentId: null } });
    await tx.feeChallan.updateMany({ where: { billedToTeacherId: id }, data: { billedToTeacherId: null } });

    // 3. Delete everything owned by the teacher.
    await tx.homework.deleteMany({ where: { teacherId: id } });
    await tx.teachingAssignment.deleteMany({ where: { teacherId: id } });
    await tx.teacherAttendance.deleteMany({ where: { teacherId: id } });
    await tx.teacherPeriodAttendance.deleteMany({ where: { teacherId: id } });
    await tx.salarySlip.deleteMany({ where: { teacherId: id } });
    await tx.teacherQualification.deleteMany({ where: { teacherId: id } });
    await tx.transportAssignment.deleteMany({ where: { teacherId: id } });
    await tx.teacherProfile.delete({ where: { id } });

    // 4. Remove the login itself (cascades AdminPermission, notifications, and
    //    the teacher's own audit logs).
    await tx.user.delete({ where: { id: userId } });

    // The purge log belongs to the admin, so it survives the user delete.
    const actorUser = await tx.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });
    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        actorName: actorUser?.fullName ?? 'Admin',
        actorRole: actor.role,
        action: 'DELETE',
        module: 'STAFF',
        targetType: 'Teacher',
        targetId: id,
        targetLabel: `${name} (${teacher.employeeId})`,
        details: `Admin purged teacher record for ${name} (${teacher.employeeId})`,
      },
    });
    // Many sequential deletes against a remote DB — allow ample time.
  }, { timeout: 60_000, maxWait: 20_000 });

  // Best-effort file cleanup (outside the transaction).
  if (avatarUrl) await deleteFile(avatarUrl).catch(() => undefined);
  for (const url of attachments) await deleteFile(url).catch(() => undefined);

  return { id, name, deleted: true };
}
