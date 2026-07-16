import { Prisma, Role, UserStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { hashPassword } from '../../utils/password';
import { publicUrl, replaceFile } from '../../services/storage';
import { AppError, NotFound } from '../../utils/apiResponse';
import type { CreateTeacherInput, ListTeachersQuery, UpdateTeacherInput } from './teachers.schema';

const teacherInclude = {
  user: true,
  teachingAssignments: { include: { section: { include: { class: true } }, subject: true } },
  classTeacherSections: { include: { class: true } },
} satisfies Prisma.TeacherProfileInclude;

type TeacherWithRels = Prisma.TeacherProfileGetPayload<{ include: typeof teacherInclude }>;
type TeachingRow = TeacherWithRels['teachingAssignments'][number];
type SectionRow = TeacherWithRels['classTeacherSections'][number];

function shapeTeaching(ta: TeachingRow) {
  return {
    id: ta.id,
    section: { id: ta.section.id, name: ta.section.name, classId: ta.section.classId, className: ta.section.class.name },
    subject: { id: ta.subject.id, name: ta.subject.name },
  };
}

function shapeClassTeacherSection(s: SectionRow) {
  return { id: s.id, name: s.name, classId: s.classId, className: s.class.name };
}

/** Shape a teacher for a detail view. `salary` is included ONLY when allowed. */
function shapeTeacher(profile: TeacherWithRels, includeSalary: boolean) {
  return {
    id: profile.id,
    userId: profile.userId,
    cnic: profile.user.cnic,
    fullName: profile.user.fullName,
    phone: profile.user.phone,
    avatarUrl: publicUrl(profile.user.avatarUrl),
    employeeId: profile.employeeId,
    qualification: profile.qualification,
    address: profile.address,
    joiningDate: profile.joiningDate,
    status: profile.status,
    ...(includeSalary ? { salary: profile.salary.toString() } : {}),
    teachingAssignments: profile.teachingAssignments.map(shapeTeaching),
    classTeacherSections: profile.classTeacherSections.map(shapeClassTeacherSection),
  };
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
          qualification: input.qualification ?? null,
          address: input.address ?? null,
          joiningDate: input.joiningDate,
          salary: new Prisma.Decimal(input.salary),
          status: UserStatus.ACTIVE,
        },
      },
    },
    include: { teacherProfile: true },
  });
  return getTeacher(user.teacherProfile!.id, true);
}

export async function updateTeacher(id: string, data: UpdateTeacherInput) {
  const profile = await prisma.teacherProfile.findUnique({ where: { id } });
  if (!profile) throw NotFound('Teacher not found');

  if (data.employeeId && data.employeeId !== profile.employeeId) {
    const clash = await prisma.teacherProfile.findUnique({ where: { employeeId: data.employeeId } });
    if (clash) throw new AppError('A teacher with this employee ID already exists', 409, 'EMPLOYEE_ID_TAKEN');
  }

  await prisma.teacherProfile.update({
    where: { id },
    data: {
      employeeId: data.employeeId ?? undefined,
      qualification: data.qualification === undefined ? undefined : data.qualification,
      address: data.address === undefined ? undefined : data.address,
      joiningDate: data.joiningDate ?? undefined,
      salary: data.salary === undefined ? undefined : new Prisma.Decimal(data.salary),
      user: {
        update: {
          fullName: data.fullName ?? undefined,
          phone: data.phone === undefined ? undefined : data.phone,
        },
      },
    },
  });
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
