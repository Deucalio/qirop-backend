import { PermissionModule, Role } from '@prisma/client';
import { prisma } from '../config/prisma';

export type PermAction = 'view' | 'edit' | 'manage';

/**
 * Whether a user may perform `action` on `module`. SUPERADMIN always may; ADMIN
 * is checked against AdminPermission (hierarchical manage⇒edit⇒view); anyone
 * else may not. Mirrors the requirePermission middleware for use inside services
 * that also allow non-admin actors (e.g. a class teacher marking attendance).
 */
export async function userHasPermission(
  userId: string,
  role: Role,
  module: PermissionModule,
  action: PermAction,
): Promise<boolean> {
  if (role === Role.SUPERADMIN) return true;
  if (role !== Role.ADMIN) return false;
  const p = await prisma.adminPermission.findUnique({ where: { userId_module: { userId, module } } });
  if (!p) return false;
  if (action === 'view') return p.canView || p.canEdit || p.canManage;
  if (action === 'edit') return p.canEdit || p.canManage;
  return p.canManage;
}
