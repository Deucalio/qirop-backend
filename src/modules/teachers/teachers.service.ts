import { AttendanceStatus, MarkingType, PermissionModule, Prisma, Role, UserStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { hashPassword } from '../../utils/password';
import { publicUrl, replaceFile, deleteFile, deleteFilesBatch, uploadFile, proxyDownload } from '../../services/storage';
import { logAudit } from '../audit/audit.service';
import { AppError, Forbidden, NotFound } from '../../utils/apiResponse';
import { userHasPermission } from '../../utils/permissions';
import { summarize } from '../../utils/attendanceMetrics';
import { pktDay, pktDayString, pktMonthRange } from '../../utils/pktDate';
import type { CreateTeacherInput, ListTeachersQuery, UpdateTeacherInput } from './teachers.schema';
import { studentDues, getStudentFeeDetails } from '../students/students.service';
import { money, ZERO, toMoneyString } from '../../utils/money';
import { formatPartialCnic } from '../../utils/cnic';
import { nextEmployeeId } from '../../utils/employeeId';
import type { Response } from 'express';
import { TEACHING_STAFF_ROLES, isTeachingRole, STAFF_ROLE_LABELS } from '../../utils/staffRoles';

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
  documents: true,
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
async function shapeTeacher(profile: TeacherWithRels, includeSalary: boolean) {
  const parentProfile = (profile.user as any).parentProfile;
  const rawChildren = parentProfile?.students ?? [];
  const studentIds = rawChildren.map((s: any) => s.id);
  const feeMap = await getStudentFeeDetails(studentIds);

  const children = rawChildren.map((s: any) => ({
    id: s.id,
    name: `${s.firstName} ${s.lastName}`,
    admissionNo: s.admissionNo,
    className: s.section.class.name,
    sectionName: s.section.name,
    status: s.status,
    fees: feeMap.get(s.id) ?? { outstanding: '0.00', unpaidCount: 0, status: 'NO_DUES' as const, challans: [] },
  }));

  return {
    id: profile.id,
    userId: profile.userId,
    role: profile.user.role,
    cnic: profile.user.cnic,
    fullName: profile.user.fullName,
    designation: profile.user.designation,
    phone: profile.user.phone,
    avatarUrl: publicUrl(profile.user.avatarUrl),
    employeeId: profile.employeeId,
    staffRole: profile.staffRole,
    gender: profile.gender,
    qualification: profile.qualification,
    address: profile.address,
    joiningDate: profile.joiningDate,
    status: profile.status,
    fatherName: profile.fatherName,
    parentCnic: profile.parentCnic,
    documents: profile.documents?.map((d) => ({
      id: d.id,
      label: d.label,
      fileUrl: d.fileUrl,
      createdAt: d.createdAt,
    })) || [],
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

/**
 * Resolve a staff profile by its own id, falling back to the owning User id.
 * The unified staff list keys rows by `teacherProfile.id ?? user.id`, so both
 * forms reach this; a system user with no staff profile still 404s, and the UI
 * uses `hasStaffProfile` to avoid asking in the first place.
 */
async function loadTeacherOr404(id: string): Promise<TeacherWithRels> {
  const profile =
    (await prisma.teacherProfile.findUnique({ where: { id }, include: teacherInclude })) ??
    (await prisma.teacherProfile.findFirst({ where: { userId: id }, include: teacherInclude }));
  if (!profile) throw NotFound('Teacher not found');
  return profile;
}

export async function listTeachers(query: ListTeachersQuery) {
  const qCnic = query.search ? formatPartialCnic(query.search) : '';
  const users = await prisma.user.findMany({
    // Both clauses are ORs, so they must be AND-ed explicitly — as two `OR`
    // keys on one object the search would overwrite the staff filter and the
    // list would start returning parents.
    where: {
      status: query.status,
      AND: [
        query.scope === 'teaching'
          ? // Assignable teaching staff. Keyed on `staffRole`, not the account
            // role: a driver or gardener also carries `role: TEACHER` with a
            // profile, and used to appear in every class-teacher dropdown.
            { role: Role.TEACHER, teacherProfile: { staffRole: { in: TEACHING_STAFF_ROLES } } }
          : query.scope === 'payrolled'
            ? // Anyone a salary can be deducted from — an admin on payroll may
              // legitimately ride a school route.
              { teacherProfile: { isNot: null } }
            : {
                OR: [
                  { role: { in: [Role.SUPERADMIN, Role.ADMIN] } },
                  { teacherProfile: { isNot: null } },
                ],
              },
        ...(query.search
          ? [
              {
                OR: [
                  { fullName: { contains: query.search, mode: 'insensitive' as const } },
                  { cnic: { contains: query.search, mode: 'insensitive' as const } },
                  { cnic: { contains: qCnic, mode: 'insensitive' as const } },
                  { teacherProfile: { employeeId: { contains: query.search, mode: 'insensitive' as const } } },
                  { teacherProfile: { parentCnic: { contains: query.search, mode: 'insensitive' as const } } },
                  { teacherProfile: { parentCnic: { contains: qCnic, mode: 'insensitive' as const } } },
                ],
              },
            ]
          : []),
      ],
    },
    include: {
      adminPermissions: true,
      teacherProfile: {
        include: {
          staffChildren: { select: { id: true } },
          _count: { select: { teachingAssignments: true, classTeacherSections: true } },
          // What they actually teach and where — so pickers can show real
          // context ("English · Class 1-A") instead of a bare count.
          teachingAssignments: {
            select: {
              subject: { select: { name: true, colorHex: true } },
              section: { select: { name: true, isDefault: true, class: { select: { name: true } } } },
            },
          },
          classTeacherSections: {
            select: { name: true, isDefault: true, class: { select: { name: true } } },
          },
        },
      },
      parentProfile: {
        include: {
          students: { select: { id: true } },
        },
      },
    },
    orderBy: { fullName: 'asc' },
  });

  const allStudentIds: string[] = [];
  for (const u of users) {
    if (u.parentProfile?.students) {
      for (const s of u.parentProfile.students) allStudentIds.push(s.id);
    }
    if (u.teacherProfile?.staffChildren) {
      for (const s of u.teacherProfile.staffChildren) allStudentIds.push(s.id);
    }
  }

  const duesMap = await studentDues(allStudentIds);

  return users.map((u) => {
    const tp = u.teacherProfile;
    const studentIds = Array.from(
      new Set([
        ...(u.parentProfile?.students.map((s) => s.id) || []),
        ...(tp?.staffChildren?.map((s) => s.id) || []),
      ])
    );

    let totalDues = ZERO;
    let unpaidCount = 0;
    for (const sid of studentIds) {
      const d = duesMap.get(sid);
      if (d) {
        totalDues = totalDues.plus(money(d.outstanding));
        unpaidCount += d.unpaidCount;
      }
    }

    return {
      id: tp?.id || u.id,
      userId: u.id,
      role: u.role,
      fullName: u.fullName,
      cnic: u.cnic,
      parentCnic: tp?.parentCnic ?? null,
      employeeId: tp?.employeeId ?? `USR-${u.id.slice(-4).toUpperCase()}`,
      /** What they do. Null for a login-only account with no staff profile. */
      staffRole: tp?.staffRole ?? null,
      /** Whether they may be put in front of a class. */
      isTeachingStaff: isTeachingRole(tp?.staffRole),
      // False for a system login with no staff profile (no salary, no
      // assignments, and no teacher profile dialog to open).
      hasStaffProfile: !!tp,
      // Fall back to what the person actually is. Reads `staffRole` rather than
      // assuming a staff profile means teaching — a clerk or gardener was being
      // labelled "Teacher" under their own non-teaching badge.
      designation:
        u.designation ??
        (u.role === Role.SUPERADMIN
          ? 'Super Admin'
          : u.role === Role.ADMIN
            ? 'Admin'
            : tp
              ? STAFF_ROLE_LABELS[tp.staffRole]
              : null),
      avatarUrl: publicUrl(u.avatarUrl),
      phone: u.phone,
      salary: tp?.salary ? tp.salary.toString() : null,
      status: u.status,
      subjectCount: tp?._count.teachingAssignments ?? 0,
      classTeacherCount: tp?._count.classTeacherSections ?? 0,
      teaches:
        tp?.teachingAssignments.map((ta) => ({
          subject: ta.subject.name,
          color: ta.subject.colorHex,
          className: ta.section.class.name,
          sectionName: ta.section.isDefault ? null : ta.section.name,
        })) ?? [],
      classTeacherOf:
        tp?.classTeacherSections.map((s) => ({
          className: s.class.name,
          sectionName: s.isDefault ? null : s.name,
        })) ?? [],
      moduleCount: u.role === 'SUPERADMIN' ? 10 : (u.adminPermissions?.length ?? 0),
      adminPermissions: u.adminPermissions ?? [],
      kidsEnrolledCount: studentIds.length,
      collectiveDues: {
        outstanding: toMoneyString(totalDues),
        unpaidCount,
      },
    };
  });
}

export async function getTeacher(id: string, includeSalary: boolean) {
  const profile = await loadTeacherOr404(id);
  return await shapeTeacher(profile, includeSalary);
}

/** Teacher self-view — NEVER includes salary. */
export async function getMeTeacher(userId: string) {
  const profile = await prisma.teacherProfile.findUnique({ where: { userId }, include: teacherInclude });
  if (!profile) throw NotFound('Teacher profile not found');
  return await shapeTeacher(profile, false);
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

  let employeeId = input.employeeId;
  if (!employeeId || !employeeId.trim()) {
    employeeId = await nextEmployeeId(prisma);
  }

  const empTaken = await prisma.teacherProfile.findUnique({ where: { employeeId } });
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
      designation: input.designation ?? null,
      phone: input.phone ?? null,
      passwordHash,
      role: Role.TEACHER,
      createdById: actorId,
      teacherProfile: {
        create: {
          employeeId: employeeId,
          staffRole: input.staffRole,
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
  const teacherObj = await getTeacher(user.teacherProfile!.id, true);

  await logAudit(null, {
    actorId,
    action: 'CREATE',
    module: 'STAFF',
    targetType: 'Teacher',
    targetId: user.teacherProfile!.id,
    targetLabel: `${input.fullName} (${employeeId})`,
    details: `Added new teacher ${input.fullName} (${employeeId}) - ${input.qualification || 'Staff Member'}`,
    changes: {
      _meta: {
        photoUrl: teacherObj.avatarUrl,
        phone: input.phone,
        cnic: input.cnic,
        fatherName: input.fatherName,
        qualification: input.qualification,
      },
    },
  });

  return teacherObj;
}

/**
 * The scalar fields of a staff record, flattened for comparison.
 *
 * Relations, timestamps and the password hash are excluded: they either change
 * on every write or must never appear in an audit payload.
 */
function scalarSnapshot(row: {
  [k: string]: unknown;
  user?: { [k: string]: unknown } | null;
}): Record<string, string | null> {
  const SKIP = new Set([
    'id', 'userId', 'createdAt', 'updatedAt', 'passwordHash', 'avatarUrl', 'lastLoginAt',
  ]);
  const out: Record<string, string | null> = {};
  const take = (src: Record<string, unknown> | null | undefined, prefix = '') => {
    if (!src) return;
    for (const [k, v] of Object.entries(src)) {
      if (SKIP.has(k) || v === null || typeof v === 'object') {
        // Dates are objects but do carry meaning, so keep them as ISO days.
        if (v instanceof Date && !SKIP.has(k)) out[prefix + k] = v.toISOString().slice(0, 10);
        else if (v === null && !SKIP.has(k)) out[prefix + k] = null;
        continue;
      }
      out[prefix + k] = String(v);
    }
  };
  take(row as Record<string, unknown>);
  take(row.user as Record<string, unknown> | null | undefined);
  return out;
}

export async function updateTeacher(id: string, data: UpdateTeacherInput, actorId?: string, actorRole?: Role) {
  const profile = await prisma.teacherProfile.findUnique({
    where: { id },
    include: { user: true },
  });
  if (!profile) throw NotFound('Teacher not found');

  /*
   * Moving someone out of teaching would otherwise strand their academic work:
   * a "Peon" left sitting as class teacher of 5-A, still owning timetable slots
   * and homework. Those records don't disappear on their own and no picker
   * would offer the person again, so the tie could never be undone from the UI.
   * Refuse the change and say exactly what has to be reassigned first.
   */
  if (data.staffRole && data.staffRole !== profile.staffRole && !isTeachingRole(data.staffRole)) {
    const [classOf, teaches, homework] = await Promise.all([
      prisma.section.findMany({
        where: { classTeacherId: id },
        select: { name: true, class: { select: { name: true } } },
      }),
      prisma.teachingAssignment.count({ where: { teacherId: id } }),
      prisma.homework.count({ where: { teacherId: id } }),
    ]);

    const blockers: string[] = [];
    if (classOf.length > 0) {
      blockers.push(`class teacher of ${classOf.map((c) => `${c.class.name}-${c.name}`).join(', ')}`);
    }
    if (teaches > 0) blockers.push(`${teaches} subject assignment${teaches === 1 ? '' : 's'}`);
    if (homework > 0) blockers.push(`${homework} homework record${homework === 1 ? '' : 's'}`);

    if (blockers.length > 0) {
      throw new AppError(
        `${profile.user.fullName} still holds academic duties (${blockers.join('; ')}). ` +
          `Reassign those before changing them to ${STAFF_ROLE_LABELS[data.staffRole]}.`,
        409,
        'HAS_TEACHING_DUTIES',
      );
    }
  }

  if ((profile.user.role === Role.ADMIN || profile.user.role === Role.SUPERADMIN) && actorRole !== Role.SUPERADMIN) {
    throw Forbidden('Only Super Administrators can modify Administrator & System User profiles.');
  }

  if (data.employeeId && data.employeeId !== profile.employeeId) {
    const clash = await prisma.teacherProfile.findUnique({ where: { employeeId: data.employeeId } });
    if (clash) throw new AppError('A teacher with this employee ID already exists', 409, 'EMPLOYEE_ID_TAKEN');
  }

  // CNIC is the login identifier and unique across all users — report a clash
  // clearly instead of letting it surface as a raw constraint violation.
  if (data.cnic && data.cnic !== profile.user.cnic) {
    const clash = await prisma.user.findUnique({ where: { cnic: data.cnic } });
    if (clash) throw new AppError('A user with this CNIC already exists', 409, 'CNIC_TAKEN');
  }

  const changes: Record<string, any> = {};
  const changedLabels: string[] = [];

  // Scalar snapshot taken BEFORE the write, for the safety sweep further down.
  const beforeSnapshot = scalarSnapshot(profile);

  if (data.cnic && data.cnic !== profile.user.cnic) {
    changes.cnic = { before: profile.user.cnic, after: data.cnic };
    changedLabels.push('CNIC');
  }
  if (data.designation !== undefined && (data.designation || null) !== profile.user.designation) {
    changes.designation = { before: profile.user.designation ?? 'None', after: data.designation ?? 'None' };
    changedLabels.push('Designation');
  }
  if (data.fullName && data.fullName !== profile.user.fullName) {
    changes.fullName = { before: profile.user.fullName, after: data.fullName };
    changedLabels.push('Full Name');
  }
  if (data.phone !== undefined && (data.phone || null) !== profile.user.phone) {
    changes.phone = { before: profile.user.phone ?? 'None', after: data.phone ?? 'None' };
    changedLabels.push('Phone Number');
  }
  if (data.qualification !== undefined && (data.qualification || null) !== profile.qualification) {
    changes.qualification = { before: profile.qualification ?? 'None', after: data.qualification ?? 'None' };
    changedLabels.push('Qualification');
  }
  if (data.salary !== undefined && Number(data.salary) !== Number(profile.salary)) {
    changes.salary = { before: profile.salary.toString(), after: String(data.salary) };
    changedLabels.push('Base Salary');
  }
  if (data.fatherName && data.fatherName !== profile.fatherName) {
    changes.fatherName = { before: profile.fatherName, after: data.fatherName };
    changedLabels.push('Father/Husband Name');
  }
  /*
   * Everything below was editable but untracked, so changing only one of them
   * produced an empty diff — and because the audit call is gated on that diff,
   * the change was saved with no history entry at all. Reclassifying someone
   * from Teacher to Gardener is the case that surfaced it.
   */
  if (data.staffRole && data.staffRole !== profile.staffRole) {
    changes.staffRole = {
      before: STAFF_ROLE_LABELS[profile.staffRole],
      after: STAFF_ROLE_LABELS[data.staffRole],
    };
    changedLabels.push('Staff Role');
  }
  if (data.gender && data.gender !== profile.gender) {
    changes.gender = { before: profile.gender, after: data.gender };
    changedLabels.push('Gender');
  }
  if (data.address !== undefined && (data.address || null) !== profile.address) {
    changes.address = { before: profile.address ?? 'None', after: data.address ?? 'None' };
    changedLabels.push('Address');
  }
  if (data.joiningDate && new Date(data.joiningDate).getTime() !== profile.joiningDate.getTime()) {
    changes.joiningDate = {
      before: profile.joiningDate.toISOString().slice(0, 10),
      after: new Date(data.joiningDate).toISOString().slice(0, 10),
    };
    changedLabels.push('Joining Date');
  }
  if (data.parentCnic !== undefined && (data.parentCnic || null) !== profile.parentCnic) {
    changes.parentCnic = { before: profile.parentCnic ?? 'None', after: data.parentCnic ?? 'None' };
    changedLabels.push('Parent CNIC');
  }
  if (data.employeeId && data.employeeId !== profile.employeeId) {
    changes.employeeId = { before: profile.employeeId, after: data.employeeId };
    changedLabels.push('Employee ID');
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
      staffRole: data.staffRole ?? undefined,
      gender: data.gender ?? undefined,
      qualification: data.qualification === undefined ? undefined : data.qualification,
      address: data.address === undefined ? undefined : data.address,
      joiningDate: data.joiningDate ?? undefined,
      salary: data.salary === undefined ? undefined : new Prisma.Decimal(data.salary),
      fatherName: data.fatherName ?? undefined,
      parentCnic: data.parentCnic === undefined ? undefined : (data.parentCnic || null),
      ...(qualRows !== undefined
        ? { qualifications: { deleteMany: {}, create: qualRows } }
        : {}),
      user: {
        update: {
          cnic: data.cnic ?? undefined,
          fullName: data.fullName ?? undefined,
          designation: data.designation === undefined ? undefined : data.designation,
          phone: data.phone === undefined ? undefined : data.phone,
        },
      },
    },
  });
  await applyTeacherTransport(id, data.transportRouteId);
  const updatedTeacher = await getTeacher(id, true);

  /*
   * Safety net. The explicit diff above names each field, which means a field
   * added later is silent until someone remembers to extend the list — exactly
   * how a staff-role change came to be saved with no history entry.
   *
   * Re-reading the row and comparing it against the pre-write snapshot catches
   * anything the named checks missed, so a new column is audited by default
   * rather than by remembering.
   */
  const afterRow = await prisma.teacherProfile.findUnique({ where: { id }, include: { user: true } });
  if (afterRow) {
    const afterSnapshot = scalarSnapshot(afterRow);
    for (const [key, after] of Object.entries(afterSnapshot)) {
      const before = beforeSnapshot[key];
      if (before === after || key in changes) continue;
      changes[key] = { before: before ?? 'None', after: after ?? 'None' };
      changedLabels.push(key);
    }
  }

  if (changedLabels.length > 0) {
    const name = updatedTeacher.fullName;
    changes._meta = {
      photoUrl: updatedTeacher.avatarUrl,
      phone: updatedTeacher.phone,
      cnic: updatedTeacher.cnic,
      fatherName: updatedTeacher.fatherName,
      qualification: updatedTeacher.qualification,
    };

    await logAudit(null, {
      actorId: actorId ?? null,
      action: 'UPDATE',
      module: 'STAFF',
      targetType: 'Teacher',
      targetId: id,
      targetLabel: `${name} (${updatedTeacher.employeeId})`,
      details: `Updated ${changedLabels.length} field${changedLabels.length > 1 ? 's' : ''} (${changedLabels.join(', ')}) for teacher ${name}`,
      changes,
    });
  }

  return updatedTeacher;
}

export async function setTeacherStatus(id: string, status: UserStatus, force: boolean, actorRole?: Role, actorId?: string) {
  const profile = await loadTeacherOr404(id);

  if ((profile.user.role === Role.ADMIN || profile.user.role === Role.SUPERADMIN) && actorRole !== Role.SUPERADMIN) {
    throw Forbidden('Only Super Administrators can modify Administrator & System User status.');
  }

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

  const before = profile.status;
  await prisma.$transaction([
    prisma.teacherProfile.update({ where: { id }, data: { status } }),
    prisma.user.update({ where: { id: profile.userId }, data: { status } }),
  ]);

  // Deactivating staff removes their access and stops their payroll, so it
  // needs to be attributable. `force` is recorded because it means the operator
  // overrode the "still holds assignments" guard.
  await logAudit(null, {
    actorId: actorId ?? null,
    action: status === UserStatus.ACTIVE ? 'ACTIVATE' : 'DEACTIVATE',
    module: 'STAFF',
    targetType: 'Teacher',
    targetId: id,
    targetLabel: `${profile.user.fullName} (${profile.employeeId})`,
    details:
      `Set ${profile.user.fullName} to ${status}` +
      (force && status !== UserStatus.ACTIVE ? ' — forced despite existing assignments' : ''),
    changes: { status: { before, after: status } },
  });

  return getTeacher(id, true);
}

export async function resetPassword(id: string, newPassword: string, actorRole?: Role, actorId?: string) {
  const profile = await prisma.teacherProfile.findUnique({ where: { id }, include: { user: true } });
  if (!profile) throw NotFound('Teacher not found');
  if ((profile.user.role === Role.ADMIN || profile.user.role === Role.SUPERADMIN) && actorRole !== Role.SUPERADMIN) {
    throw Forbidden('Only Super Administrators can reset Administrator & System User passwords.');
  }
  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: profile.userId }, data: { passwordHash } });

  // One person taking over another's credentials is exactly what an audit trail
  // is for. The password is never recorded — only that a reset happened.
  await logAudit(null, {
    actorId: actorId ?? null,
    action: 'PASSWORD_RESET',
    module: 'STAFF',
    targetType: 'Teacher',
    targetId: id,
    targetLabel: `${profile.user.fullName} (${profile.employeeId})`,
    details: `Reset the login password for ${profile.user.fullName}`,
  });
}

export async function setPhoto(id: string, buffer: Buffer, originalName: string, contentType: string, actorRole?: Role) {
  const profile = await prisma.teacherProfile.findUnique({ where: { id }, include: { user: true } });
  if (!profile) throw NotFound('Teacher not found');
  if ((profile.user.role === Role.ADMIN || profile.user.role === Role.SUPERADMIN) && actorRole !== Role.SUPERADMIN) {
    throw Forbidden('Only Super Administrators can modify Administrator & System User photos.');
  }
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
    include: { user: true, documents: true, homework: { select: { attachmentUrl: true } } },
  });
  if (!teacher) throw NotFound('Teacher not found');

  const userId = teacher.userId;
  const name = teacher.user.fullName;
  const homeworkAttachments = teacher.homework.map((h) => h.attachmentUrl).filter((u): u is string => !!u);
  const docFiles = teacher.documents.map((d) => d.fileUrl).filter((u): u is string => !!u);
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
    await tx.teacherDocument.deleteMany({ where: { teacherId: id } });
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

  // Clean up avatar, all teacher documents, and homework attachments from FileStore API in batch
  const allPaths = [avatarUrl, ...docFiles, ...homeworkAttachments].filter(Boolean);
  if (allPaths.length > 0) {
    await deleteFilesBatch(allPaths);
  }

  return { id, name, deleted: true };
}

export async function addTeacherDocument(
  id: string,
  label: string,
  buffer: Buffer,
  originalName: string,
  contentType: string,
  actor?: Actor
) {
  const teacher = await prisma.teacherProfile.findUnique({ where: { id } });
  if (!teacher) throw NotFound('Teacher not found');

  const fileUrl = await uploadFile(buffer, originalName, `/teachers/${id}/documents`, contentType);
  await prisma.teacherDocument.create({
    data: {
      teacherId: id,
      label,
      fileUrl,
    },
  });

  if (actor) {
    await logAudit(null, {
      actorId: actor.userId,
      action: 'UPDATE',
      module: 'STAFF',
      targetType: 'Teacher',
      targetId: id,
      targetLabel: `Teacher (${teacher.employeeId})`,
      details: `Added teacher document: "${label}".`,
    });
  }

  return getTeacher(id, true);
}

export async function removeTeacherDocument(teacherId: string, docId: string, actor?: Actor) {
  const doc = await prisma.teacherDocument.findUnique({ where: { id: docId } });
  if (!doc || doc.teacherId !== teacherId) throw NotFound('Document not found');

  await deleteFile(doc.fileUrl).catch(() => undefined);
  await prisma.teacherDocument.delete({ where: { id: docId } });

  if (actor) {
    await logAudit(null, {
      actorId: actor.userId,
      action: 'UPDATE',
      module: 'STAFF',
      targetType: 'Teacher',
      targetId: teacherId,
      targetLabel: `Teacher ${teacherId}`,
      details: `Removed teacher document: "${doc.label}".`,
    });
  }

  return getTeacher(teacherId, true);
}

export async function downloadTeacherDocument(
  teacherId: string,
  docId: string,
  res: Response,
  disposition: 'inline' | 'attachment' = 'attachment'
) {
  const doc = await prisma.teacherDocument.findUnique({ where: { id: docId } });
  if (!doc || doc.teacherId !== teacherId) throw NotFound('Document not found');

  await proxyDownload(doc.fileUrl, res, disposition);
}
