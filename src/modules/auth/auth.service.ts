import { PermissionModule, Role } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { hashPassword, verifyPassword } from '../../utils/password';
import { signToken } from '../../utils/jwt';
import { publicUrl } from '../../services/storage';
import { AppError, Forbidden, NotFound } from '../../utils/apiResponse';

export interface PermissionDTO {
  module: PermissionModule;
  canView: boolean;
  canEdit: boolean;
  canManage: boolean;
}

export interface AuthenticatedUser {
  id: string;
  fullName: string;
  role: Role;
  permissions: PermissionDTO[];
}

// A pre-computed bcrypt hash used to equalise timing when the CNIC is unknown,
// so login can't be used to enumerate valid accounts by response time.
const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEeO3f6i0Xb5s.9m0aBk1t6i5uJ5m5g8yqK';

const ALL_MODULES = Object.values(PermissionModule);

function fullPermissionSet(): PermissionDTO[] {
  return ALL_MODULES.map((module) => ({
    module,
    canView: true,
    canEdit: true,
    canManage: true,
  }));
}

/**
 * SUPERADMIN → full permission set (all modules, all actions).
 * ADMIN → their stored AdminPermission rows.
 * TEACHER / PARENT → empty (scoped access is enforced per-feature later).
 */
export async function getPermissionsForUser(userId: string, role: Role): Promise<PermissionDTO[]> {
  if (role === Role.SUPERADMIN) {
    return fullPermissionSet();
  }
  if (role === Role.ADMIN) {
    const rows = await prisma.adminPermission.findMany({ where: { userId } });
    return rows.map((r) => ({
      module: r.module,
      canView: r.canView,
      canEdit: r.canEdit,
      canManage: r.canManage,
    }));
  }
  return [];
}

export interface LoginResult {
  token: string;
  user: AuthenticatedUser;
}

export async function login(cnic: string, password: string): Promise<LoginResult> {
  const user = await prisma.user.findUnique({ where: { cnic } });

  // Generic failure — never reveal whether it was the CNIC or the password.
  const invalidCredentials = new AppError('Invalid CNIC or password', 401, 'INVALID_CREDENTIALS');

  if (!user) {
    await verifyPassword(password, DUMMY_HASH); // equalise timing
    throw invalidCredentials;
  }

  const passwordMatches = await verifyPassword(password, user.passwordHash);
  if (!passwordMatches) {
    throw invalidCredentials;
  }

  if (user.status !== 'ACTIVE') {
    throw Forbidden('Your account is not active. Please contact an administrator.');
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  const permissions = await getPermissionsForUser(user.id, user.role);
  const token = signToken({ userId: user.id, role: user.role });

  return {
    token,
    user: { id: user.id, fullName: user.fullName, role: user.role, permissions },
  };
}

/** Current user profile for `/me`. Never includes passwordHash or teacher salary. */
export async function getMe(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      // Explicit selects — the `salary` field is deliberately excluded.
      teacherProfile: {
        select: {
          id: true,
          employeeId: true,
          qualification: true,
          address: true,
          joiningDate: true,
          status: true,
        },
      },
      parentProfile: {
        select: { id: true, occupation: true, address: true },
      },
    },
  });

  if (!user) {
    throw NotFound('User not found');
  }

  const permissions = await getPermissionsForUser(user.id, user.role);

  return {
    id: user.id,
    cnic: user.cnic,
    fullName: user.fullName,
    role: user.role,
    status: user.status,
    phone: user.phone,
    avatarUrl: publicUrl(user.avatarUrl),
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    teacherProfile: user.teacherProfile ?? null,
    parentProfile: user.parentProfile ?? null,
    permissions,
  };
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw NotFound('User not found');
  }

  const currentMatches = await verifyPassword(currentPassword, user.passwordHash);
  if (!currentMatches) {
    throw new AppError('Current password is incorrect', 400, 'INVALID_PASSWORD');
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
}
