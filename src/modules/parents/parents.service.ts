import { Role, UserStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { hashPassword } from '../../utils/password';
import { AppError, NotFound } from '../../utils/apiResponse';
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
    include: { user: true, _count: { select: { students: true } } },
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
  return getParent(user.parentProfile!.id);
}

export async function updateParent(id: string, data: UpdateParentInput) {
  const parent = await prisma.parentProfile.findUnique({ where: { id } });
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
  return getParent(id);
}

export async function setStatus(id: string, status: UserStatus) {
  const parent = await prisma.parentProfile.findUnique({ where: { id } });
  if (!parent) throw NotFound('Parent not found');
  await prisma.user.update({ where: { id: parent.userId }, data: { status } });
  return getParent(id);
}

export async function resetPassword(id: string, newPassword: string) {
  const parent = await prisma.parentProfile.findUnique({ where: { id } });
  if (!parent) throw NotFound('Parent not found');
  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: parent.userId }, data: { passwordHash } });
}
