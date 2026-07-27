import { Role, UserStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { hashPassword } from '../../utils/password';
import { AppError, NotFound } from '../../utils/apiResponse';
import { logAudit } from '../audit/audit.service';
import type { CreateParentInput, ListParentsQuery, UpdateParentInput } from './parents.schema';

export async function listParents(query: ListParentsQuery) {
  const parents = await prisma.parentProfile.findMany({
    where: {
      user: {
        status: query.status,
        ...(query.search
          ? {
              OR: [
                { fullName: { contains: query.search, mode: 'insensitive' } },
                { cnic: { contains: query.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
    },
    include: {
      user: { include: { teacherProfile: { select: { id: true } } } },
      _count: { select: { students: true } },
    },
    orderBy: { user: { fullName: 'asc' } },
  });
  return parents.map((p) => ({
    id: p.id,
    userId: p.userId,
    fullName: p.user.fullName,
    cnic: p.user.cnic,
    phone: p.user.phone,
    status: p.user.status,
    occupation: p.occupation,
    childrenCount: p._count.students,
    // This parent is also a teacher → their children's fees bill to their salary.
    isTeacher: p.user.teacherProfile !== null,
    teacherId: p.user.teacherProfile?.id ?? null,
  }));
}

export async function getParent(id: string) {
  const parent = await prisma.parentProfile.findUnique({
    where: { id },
    include: {
      user: true,
      students: { include: { section: { include: { class: true } } }, orderBy: { firstName: 'asc' } },
    },
  });
  if (!parent) throw NotFound('Parent not found');
  return {
    id: parent.id,
    userId: parent.userId,
    fullName: parent.user.fullName,
    cnic: parent.user.cnic,
    phone: parent.user.phone,
    status: parent.user.status,
    occupation: parent.occupation,
    address: parent.address,
    createdAt: parent.createdAt,
    children: parent.students.map((s) => ({
      id: s.id,
      name: `${s.firstName} ${s.lastName}`,
      admissionNo: s.admissionNo,
      className: s.section.class.name,
      sectionName: s.section.name,
      status: s.status,
    })),
  };
}

export async function createParent(actorId: string, input: CreateParentInput) {
  const cnicTaken = await prisma.user.findUnique({ where: { cnic: input.cnic } });
  if (cnicTaken) throw new AppError('A user with this CNIC already exists', 409, 'CNIC_TAKEN');

  const passwordHash = await hashPassword(input.password);
  const user = await prisma.user.create({
    data: {
      cnic: input.cnic,
      fullName: input.fullName,
      phone: input.phone ?? null,
      passwordHash,
      role: Role.PARENT,
      createdById: actorId,
      parentProfile: {
        create: { occupation: input.occupation ?? null, address: input.address ?? null },
      },
    },
    include: { parentProfile: true },
  });
  await logAudit(null, {
    actorId,
    action: 'CREATE',
    module: 'USERS',
    targetType: 'Parent',
    targetId: user.parentProfile!.id,
    targetLabel: `${user.fullName} (${user.cnic})`,
    details: `Registered guardian ${user.fullName}`,
  });
  return getParent(user.parentProfile!.id);
}

export async function updateParent(id: string, data: UpdateParentInput, actorId?: string) {
  const parent = await prisma.parentProfile.findUnique({ where: { id }, include: { user: true } });
  if (!parent) throw NotFound('Parent not found');
  await prisma.parentProfile.update({
    where: { id },
    data: {
      occupation: data.occupation === undefined ? undefined : data.occupation,
      address: data.address === undefined ? undefined : data.address,
      user: {
        update: {
          fullName: data.fullName ?? undefined,
          phone: data.phone === undefined ? undefined : data.phone,
        },
      },
    },
  });

  // Record only the fields that actually changed.
  const changes: Record<string, { before: string; after: string }> = {};
  if (data.fullName !== undefined && data.fullName !== parent.user.fullName) {
    changes.fullName = { before: parent.user.fullName, after: data.fullName };
  }
  if (data.phone !== undefined && (data.phone ?? null) !== (parent.user.phone ?? null)) {
    changes.phone = { before: parent.user.phone ?? 'None', after: data.phone ?? 'None' };
  }
  if (data.occupation !== undefined && (data.occupation ?? null) !== (parent.occupation ?? null)) {
    changes.occupation = { before: parent.occupation ?? 'None', after: data.occupation ?? 'None' };
  }
  if (data.address !== undefined && (data.address ?? null) !== (parent.address ?? null)) {
    changes.address = { before: parent.address ?? 'None', after: data.address ?? 'None' };
  }
  if (actorId && Object.keys(changes).length > 0) {
    await logAudit(null, {
      actorId,
      action: 'UPDATE',
      module: 'USERS',
      targetType: 'Parent',
      targetId: id,
      targetLabel: `${data.fullName ?? parent.user.fullName} (${parent.user.cnic})`,
      details: `Updated ${Object.keys(changes).length} field${Object.keys(changes).length > 1 ? 's' : ''} (${Object.keys(changes).join(', ')}) for guardian ${data.fullName ?? parent.user.fullName}`,
      changes,
    });
  }
  return getParent(id);
}

export async function setStatus(id: string, status: UserStatus, actorId?: string) {
  const parent = await prisma.parentProfile.findUnique({ where: { id }, include: { user: true } });
  if (!parent) throw NotFound('Parent not found');
  await prisma.user.update({ where: { id: parent.userId }, data: { status } });
  if (actorId) {
    await logAudit(null, {
      actorId,
      action: 'STATUS_CHANGE',
      module: 'USERS',
      targetType: 'Parent',
      targetId: id,
      targetLabel: `${parent.user.fullName} (${parent.user.cnic})`,
      details: `Guardian ${parent.user.fullName} ${status === 'ACTIVE' ? 'activated' : 'deactivated'}`,
      changes: { status: { before: parent.user.status, after: status } },
    });
  }
  return getParent(id);
}

export async function resetPassword(id: string, newPassword: string, actorId?: string) {
  const parent = await prisma.parentProfile.findUnique({ where: { id }, include: { user: true } });
  if (!parent) throw NotFound('Parent not found');
  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: parent.userId }, data: { passwordHash } });
  if (actorId) {
    await logAudit(null, {
      actorId,
      action: 'RESET',
      module: 'USERS',
      targetType: 'Parent',
      targetId: id,
      targetLabel: `${parent.user.fullName} (${parent.user.cnic})`,
      details: `Reset login password for guardian ${parent.user.fullName}`,
    });
  }
}
