import { Prisma, PermissionModule, Role, UserStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { hashPassword } from '../../utils/password';
import { AppError, Forbidden, NotFound } from '../../utils/apiResponse';
import type { CreateAdminInput, ListAdminsQuery, PermissionEntry, StaffProfileInput } from './admins.schema';
import { logAudit } from '../audit/audit.service';
import { nextEmployeeId } from '../../utils/employeeId';
import { replaceFile, publicUrl } from '../../services/storage';

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
  if (!target) {
    throw NotFound('User not found');
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
    designation: user.designation ?? null,
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
    designation: user.designation ?? null,
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
  const staff = input.staffProfile;

  const created = await prisma.$transaction(async (tx) => {
    // A staff profile is what puts someone on the payroll — without it they are
    // a login only, and their children's fees can't be settled from a salary.
    let employeeId: string | undefined;
    if (staff) {
      employeeId = staff.employeeId?.trim() || (await nextEmployeeId(tx));
      const taken = await tx.teacherProfile.findUnique({ where: { employeeId } });
      if (taken) throw new AppError('A staff member with this employee ID already exists', 409, 'EMPLOYEE_ID_TAKEN');
    }

    return tx.user.create({
      data: {
        cnic: input.cnic,
        fullName: input.fullName,
        designation: input.designation ?? null,
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
        ...(staff && employeeId
          ? {
              teacherProfile: {
                create: {
                  employeeId,
                  gender: staff.gender,
                  fatherName: staff.fatherName,
                  joiningDate: staff.joiningDate,
                  salary: staff.salary.toFixed(2),
                  qualification: staff.qualification ?? null,
                  address: staff.address ?? null,
                  parentCnic: staff.parentCnic ?? null,
                },
              },
            }
          : {}),
      },
      include: { adminPermissions: true },
    });
  });

  await logAudit(null, {
    actorId: actor.userId,
    action: 'CREATE',
    module: 'USERS',
    targetType: 'User',
    targetId: created.id,
    targetLabel: `${created.fullName} (${created.cnic})`,
    details: staff
      ? `Created system user ${created.fullName} with a staff profile (on payroll)`
      : `Created login-only system user ${created.fullName} (no staff profile, not on payroll)`,
    changes: {
      fullName: { before: null, after: created.fullName },
      cnic: { before: null, after: created.cnic },
      role: { before: null, after: created.role },
    },
  });

  return toDetail(created);
}

export async function updateAdmin(
  actor: Actor,
  id: string,
  data: { cnic?: string; fullName?: string; designation?: string | null; phone?: string | null },
) {
  const target = await loadAdminTarget(id);
  if (target.role === Role.SUPERADMIN && actor.role !== Role.SUPERADMIN) {
    throw Forbidden('You cannot modify a superadmin account');
  }

  // CNIC is the login identifier and is unique across every user, so a clash
  // must be reported clearly rather than surfacing as a raw constraint error.
  if (data.cnic && data.cnic !== target.cnic) {
    const taken = await prisma.user.findUnique({ where: { cnic: data.cnic } });
    if (taken) throw new AppError('A user with this CNIC already exists', 409, 'CNIC_TAKEN');
  }

  const updated = await prisma.user.update({
    where: { id: target.id },
    data: {
      cnic: data.cnic ?? undefined,
      fullName: data.fullName ?? undefined,
      designation: data.designation === undefined ? undefined : data.designation,
      phone: data.phone === undefined ? undefined : data.phone,
    },
    include: { adminPermissions: true },
  });

  const changes: Record<string, { before: unknown; after: unknown }> = {};
  if (data.fullName && data.fullName !== target.fullName) changes.fullName = { before: target.fullName, after: data.fullName };
  if (data.phone !== undefined && data.phone !== target.phone) changes.phone = { before: target.phone, after: data.phone };
  // Worth an explicit audit line — this changes what they sign in with.
  if (data.cnic && data.cnic !== target.cnic) changes.cnic = { before: target.cnic, after: data.cnic };

  if (Object.keys(changes).length > 0) {
    await logAudit(null, {
      actorId: actor.userId,
      action: 'UPDATE',
      module: 'USERS',
      targetType: 'User',
      targetId: target.id,
      targetLabel: `${updated.fullName}`,
      details: `Updated Admin profile info for ${updated.fullName}`,
      changes,
    });
  }

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

  await logAudit(null, {
    actorId: actor.userId,
    action: 'UPDATE',
    module: 'USERS',
    targetType: 'User',
    targetId: target.id,
    targetLabel: `${target.fullName}`,
    details: `Updated permissions matrix for Admin ${target.fullName} (${permissions.length} module permissions active)`,
  });

  return toDetail(updated);
}

/**
 * Give an existing system user a staff record.
 *
 * Accounts created before staff profiles were attachable are login-only: they
 * never appear in payroll, and their children's fees can't be settled from a
 * salary. This backfills that without recreating the account (which would break
 * every audit-log and record reference pointing at their user id).
 */
export async function attachStaffProfile(actor: Actor, id: string, input: StaffProfileInput) {
  const target = await loadAdminTarget(id);

  const existing = await prisma.teacherProfile.findUnique({ where: { userId: target.id } });
  if (existing) {
    throw new AppError('This user already has a staff record', 409, 'STAFF_PROFILE_EXISTS');
  }

  const profile = await prisma.$transaction(async (tx) => {
    const employeeId = input.employeeId?.trim() || (await nextEmployeeId(tx));
    const taken = await tx.teacherProfile.findUnique({ where: { employeeId } });
    if (taken) throw new AppError('A staff member with this employee ID already exists', 409, 'EMPLOYEE_ID_TAKEN');

    return tx.teacherProfile.create({
      data: {
        userId: target.id,
        employeeId,
        gender: input.gender,
        fatherName: input.fatherName,
        joiningDate: input.joiningDate,
        salary: input.salary.toFixed(2),
        qualification: input.qualification ?? null,
        address: input.address ?? null,
        parentCnic: input.parentCnic ?? null,
        status: target.status,
      },
    });
  });

  await logAudit(null, {
    actorId: actor.userId,
    action: 'CREATE',
    module: 'STAFF',
    targetType: 'TeacherProfile',
    targetId: profile.id,
    targetLabel: `${target.fullName} (${profile.employeeId})`,
    details: `Attached a staff record to ${target.fullName} — they now appear in payroll`,
    changes: {
      employeeId: { before: null, after: profile.employeeId },
      salary: { before: null, after: profile.salary.toString() },
    },
  });

  return { id: profile.id, employeeId: profile.employeeId };
}

/**
 * Take a system user off the payroll by removing their staff record, leaving
 * the login and its permissions untouched.
 *
 * Refused while anything real depends on the record — teaching duties, issued
 * salary slips, a commute route, or children whose fees bill to this salary.
 * Deleting through those would orphan payroll history and silently move the
 * children's fees back to cash.
 */
export async function detachStaffProfile(actor: Actor, id: string) {
  const target = await loadAdminTarget(id);

  const profile = await prisma.teacherProfile.findUnique({
    where: { userId: target.id },
    include: {
      _count: {
        select: {
          teachingAssignments: true,
          classTeacherSections: true,
          salarySlips: true,
          staffChildren: true,
        },
      },
      transportAssignment: true,
    },
  });
  if (!profile) throw new AppError('This user has no staff record', 409, 'NO_STAFF_PROFILE');

  const blockers: string[] = [];
  const c = profile._count;
  if (c.teachingAssignments > 0) blockers.push(`${c.teachingAssignments} subject assignment(s)`);
  if (c.classTeacherSections > 0) blockers.push(`class teacher of ${c.classTeacherSections} section(s)`);
  if (c.salarySlips > 0) blockers.push(`${c.salarySlips} salary slip(s) already generated`);
  if (c.staffChildren > 0) blockers.push(`${c.staffChildren} child(ren) whose fees bill to this salary`);
  if (profile.transportAssignment) blockers.push('an assigned commute route');

  if (blockers.length > 0) {
    throw new AppError(
      `Cannot remove the staff record: ${blockers.join(', ')}. Clear these first.`,
      409,
      'STAFF_PROFILE_IN_USE',
      { blockers },
    );
  }

  await prisma.teacherProfile.delete({ where: { id: profile.id } });

  await logAudit(null, {
    actorId: actor.userId,
    action: 'DELETE',
    module: 'STAFF',
    targetType: 'TeacherProfile',
    targetId: profile.id,
    targetLabel: `${target.fullName} (${profile.employeeId})`,
    details: `Removed the staff record from ${target.fullName} — they are no longer on payroll. Their login and permissions are unchanged.`,
    changes: { employeeId: { before: profile.employeeId, after: null } },
  });

  return { removed: true };
}

/**
 * Set a system user's profile picture. Stored on `User.avatarUrl`, the same
 * field the teacher photo upload writes to, so one account has one picture
 * wherever it appears.
 */
export async function setAvatar(
  actor: Actor,
  id: string,
  buffer: Buffer,
  originalName: string,
  contentType: string,
) {
  const target = await loadAdminTarget(id);
  const newPath = await replaceFile(target.avatarUrl, buffer, originalName, `/users/${target.id}`, contentType);
  await prisma.user.update({ where: { id: target.id }, data: { avatarUrl: newPath } });

  await logAudit(null, {
    actorId: actor.userId,
    action: 'UPDATE',
    module: 'USERS',
    targetType: 'User',
    targetId: target.id,
    targetLabel: `${target.fullName} (${target.cnic})`,
    details: `Updated profile picture for ${target.fullName}`,
  });

  return { avatarUrl: publicUrl(newPath) };
}

export async function resetPassword(actor: Actor, id: string, newPassword: string) {
  const target = await loadAdminTarget(id);
  if (target.role === Role.SUPERADMIN && actor.role !== Role.SUPERADMIN) {
    throw Forbidden('You cannot reset a superadmin password');
  }
  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: target.id }, data: { passwordHash } });

  await logAudit(null, {
    actorId: actor.userId,
    action: 'RESET',
    module: 'USERS',
    targetType: 'User',
    targetId: target.id,
    targetLabel: `${target.fullName}`,
    details: `Reset password for Admin account ${target.fullName}`,
  });
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

  await logAudit(null, {
    actorId: actor.userId,
    action: 'UPDATE',
    module: 'USERS',
    targetType: 'User',
    targetId: target.id,
    targetLabel: `${target.fullName}`,
    details: `Changed status of Admin account ${target.fullName} from ${target.status} to ${status}`,
    changes: {
      status: { before: target.status, after: status },
    },
  });

  return toListItem(updated);
}

export async function deleteAdmin(actor: Actor, id: string) {
  const target = await loadAdminTarget(id);

  if (target.id === actor.userId) {
    throw Forbidden('You cannot delete your own user account');
  }

  if (target.role === Role.SUPERADMIN) {
    const superAdminCount = await prisma.user.count({ where: { role: Role.SUPERADMIN } });
    if (superAdminCount <= 1) {
      throw new AppError('Cannot delete the last Super Admin account', 400, 'LAST_SUPERADMIN');
    }
  }

  await prisma.$transaction(async (tx) => {
    // Delete permissions
    await tx.adminPermission.deleteMany({ where: { userId: target.id } });

    // Re-attribute actor references to acting admin
    await tx.user.updateMany({ where: { createdById: target.id }, data: { createdById: actor.userId } });
    await tx.feePayment.updateMany({ where: { receivedById: target.id }, data: { receivedById: actor.userId } });
    await tx.feePayment.updateMany({ where: { reversedById: target.id }, data: { reversedById: actor.userId } });
    await tx.expense.updateMany({ where: { recordedById: target.id }, data: { recordedById: actor.userId } });
    await tx.salarySlip.updateMany({ where: { generatedById: target.id }, data: { generatedById: actor.userId } });
    await tx.studentAttendance.updateMany({ where: { markedById: target.id }, data: { markedById: actor.userId } });
    await tx.teacherPeriodAttendance.updateMany({ where: { markedById: target.id }, data: { markedById: actor.userId } });

    // Delete user account
    await tx.user.delete({ where: { id: target.id } });
  });

  await logAudit(null, {
    actorId: actor.userId,
    action: 'DELETE',
    module: 'USERS',
    targetType: 'User',
    targetId: id,
    targetLabel: `${target.fullName} (${target.cnic})`,
    details: `Deleted admin account ${target.fullName} (${target.role})`,
  });
}
