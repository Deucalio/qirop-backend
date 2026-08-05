import { PermissionModule, Role } from '@prisma/client';
import { prisma } from '../config/prisma';

export type PermAction = 'view' | 'edit' | 'manage';

/**
 * Whether a user may perform `action` on `module`. SUPERADMIN always may;
 * everyone else is checked against their AdminPermission row (hierarchical
 * manage⇒edit⇒view), regardless of role — a teacher who has been granted a
 * module is a system user for that module.
 *
 * This MUST mirror the requirePermission middleware. Both deliberately key off
 * the grant rather than the role, so staff can hold admin duties on one
 * account; a user with no grant still resolves to false exactly as before.
 */
export async function userHasPermission(
  userId: string,
  role: Role,
  module: PermissionModule,
  action: PermAction,
): Promise<boolean> {
  if (role === Role.SUPERADMIN) return true;
  const p = await prisma.adminPermission.findUnique({ where: { userId_module: { userId, module } } });
  if (!p) return false;
  if (action === 'view') return p.canView || p.canEdit || p.canManage;
  return p.canEdit || p.canManage;
}
