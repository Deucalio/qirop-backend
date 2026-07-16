import { Prisma, PermissionModule, Role, UserStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { hashPassword } from '../../utils/password';
import { AppError, Forbidden, NotFound } from '../../utils/apiResponse';
import type { CreateAdminInput, ListAdminsQuery, PermissionEntry } from './admins.schema';

const ALL_MODULES = Object.values(PermissionModule);
const ADMIN_TIER: Role[] = [Role.SUPERADMIN, Role.ADMIN];

export interface Actor {
  userId: string;
  role: Role;
}

type PermFlag = 'view' | 'edit' | 'manage';

interface ActorCapabilities {
  isSuperadmin: boolean;
  /** Whether the actor may grant `flag` on `module` (hierarchical: manage⇒edit⇒view). */
  can: (module: PermissionModule, flag: PermFlag) => boolean;
}

async function getActorCapabilities(actor: Actor): Promise<ActorCapabilities> {
  if (actor.role === Role.SUPERADMIN) {
    return { isSuperadmin: true, can: () => true };
  }
  const rows = await prisma.adminPermission.findMany({ where: { userId: actor.userId } });
  const map = new Map(rows.map((r) => [r.module, r]));
  return {
    isSuperadmin: false,
    can: (module, flag) => {
      const p = map.get(module);
      if (!p) return false;
      if (flag === 'view') return p.canView || p.canEdit || p.canManage;
      if (flag === 'edit') return p.canEdit || p.canManage;
      return p.canManage;
    },
  };
}

/** Reject any attempt to grant a flag the actor does not themselves hold. */
function assertNoEscalation(caps: ActorCapabilities, requested: PermissionEntry[]): void {
  if (caps.isSuperadmin) return;
  for (const p of requested) {
    const violates =
      (p.canView && !caps.can(p.module, 'view')) ||
      (p.canEdit && !caps.can(p.module, 'edit')) ||
      (p.canManage && !caps.can(p.module, 'manage'));
    if (violates) {
      throw new AppError(
        `You cannot grant permissions you do not have (module ${p.module})`,
        403,
        'PERMISSION_ESCALATION',
      );
    }
  }
}

async function loadAdminTarget(id: string) {
  const target = await prisma.user.findUnique({
    where: { id },
    include: { adminPermissions: true },
  });
  if (!target || !ADMIN_TIER.includes(target.role)) {
    throw NotFound('Admin user not found');
  }
  return target;
}

/** Only keep entries that grant at least one flag (all-false = no access). */
function meaningfulPermissions(entries: PermissionEntry[]): PermissionEntry[] {
  return entries.filter((p) => p.canView || p.canEdit || p.canManage);
}

// ---- Shaping (never expose passwordHash) ----------------------------------

function fullMatrix(): PermissionEntry[] {
  return ALL_MODULES.map((module) => ({ module, canView: true, canEdit: true, canManage: true }));
}

function toMatrix(rows: { module: PermissionModule; canView: boolean; canEdit: boolean; canManage: boolean }[]) {
  const byModule = new Map(rows.map((r) => [r.module, r]));
  return ALL_MODULES.map((module) => {
    const r = byModule.get(module);
    return {
      module,
      canView: r?.canView ?? false,
      canEdit: r?.canEdit ?? false,
      canManage: r?.canManage ?? false,
    };
  });
}

type AdminWithPerms = Prisma.UserGetPayload<{ include: { adminPermissions: true } }>;

function moduleCount(user: AdminWithPerms): number {
  if (user.role === Role.SUPERADMIN) return ALL_MODULES.length;
  return user.adminPermissions.filter((p) => p.canView || p.canEdit || p.canManage).length;
}

function toListItem(user: AdminWithPerms) {
  return {
    id: user.id,
    cnic: user.cnic,
    fullName: user.fullName,
    phone: user.phone,
    role: user.role,
    status: user.status,
    moduleCount: moduleCount(user),
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

function toDetail(user: AdminWithPerms) {
  return {
    id: user.id,
    cnic: user.cnic,
    fullName: user.fullName,
    phone: user.phone,
    role: user.role,
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    permissions: user.role === Role.SUPERADMIN ? fullMatrix() : toMatrix(user.adminPermissions),
  };
}

// ---- Operations -----------------------------------------------------------

export async function listAdmins(query: ListAdminsQuery) {
  const users = await prisma.user.findMany({
    where: {
      role: { in: ADMIN_TIER },
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
    include: { adminPermissions: true },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
  });
  return users.map(toListItem);
}

export async function getAdmin(id: string) {
  const target = await loadAdminTarget(id);
  return toDetail(target);
}

export async function createAdmin(actor: Actor, input: CreateAdminInput) {
  const caps = await getActorCapabilities(actor);
  const permissions = meaningfulPermissions(input.permissions);
  assertNoEscalation(caps, permissions);

  const existing = await prisma.user.findUnique({ where: { cnic: input.cnic } });
  if (existing) {
    throw new AppError('A user with this CNIC already exists', 409, 'CNIC_TAKEN');
  }

  const passwordHash = await hashPassword(input.password);

  const created = await prisma.user.create({
    data: {
      cnic: input.cnic,
      fullName: input.fullName,
      phone: input.phone ?? null,
      passwordHash,
      role: Role.ADMIN, // never SUPERADMIN — no promotion via this endpoint
      createdById: actor.userId,
      adminPermissions: {
        create: permissions.map((p) => ({
          module: p.module,
          canView: p.canView,
          canEdit: p.canEdit,
          canManage: p.canManage,
        })),
      },
    },
    include: { adminPermissions: true },
  });

  return toDetail(created);
}

export async function updateAdmin(
  actor: Actor,
  id: string,
  data: { fullName?: string; phone?: string | null },
) {
  const target = await loadAdminTarget(id);
  if (target.role === Role.SUPERADMIN && actor.role !== Role.SUPERADMIN) {
    throw Forbidden('You cannot modify a superadmin account');
  }

  const updated = await prisma.user.update({
    where: { id: target.id },
    data: {
      fullName: data.fullName ?? undefined,
      phone: data.phone === undefined ? undefined : data.phone,
    },
    include: { adminPermissions: true },
  });
  return toDetail(updated);
}

export async function replacePermissions(actor: Actor, id: string, entries: PermissionEntry[]) {
  const target = await loadAdminTarget(id);

  if (target.role === Role.SUPERADMIN) {
    throw new AppError('Superadmin permissions are implicit and cannot be modified', 400, 'SUPERADMIN_PERMISSIONS');
  }

  const caps = await getActorCapabilities(actor);
  if (!caps.isSuperadmin) {
    if (target.id === actor.userId) {
      throw Forbidden('You cannot edit your own permissions');
    }
    assertNoEscalation(caps, entries);
  }

  const permissions = meaningfulPermissions(entries);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.adminPermission.deleteMany({ where: { userId: target.id } });
    if (permissions.length > 0) {
      await tx.adminPermission.createMany({
        data: permissions.map((p) => ({
          userId: target.id,
          module: p.module,
          canView: p.canView,
          canEdit: p.canEdit,
          canManage: p.canManage,
        })),
      });
    }
    return tx.user.findUniqueOrThrow({
      where: { id: target.id },
      include: { adminPermissions: true },
    });
  });

  return toDetail(updated);
}

export async function resetPassword(actor: Actor, id: string, newPassword: string) {
  const target = await loadAdminTarget(id);
  if (target.role === Role.SUPERADMIN && actor.role !== Role.SUPERADMIN) {
    throw Forbidden('You cannot reset a superadmin password');
  }
  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: target.id }, data: { passwordHash } });
}

export async function updateStatus(actor: Actor, id: string, status: UserStatus) {
  const target = await loadAdminTarget(id);

  if (target.id === actor.userId) {
    throw Forbidden('You cannot change your own account status');
  }
  if (target.role === Role.SUPERADMIN && actor.role !== Role.SUPERADMIN) {
    throw Forbidden('You cannot change a superadmin account status');
  }

  const updated = await prisma.user.update({
    where: { id: target.id },
    data: { status },
    include: { adminPermissions: true },
  });
  return toListItem(updated);
}
