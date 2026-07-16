import type { Request, Response, NextFunction } from 'express';
import { PermissionModule, Role } from '@prisma/client';
import { prisma } from '../config/prisma';
import { Unauthorized, Forbidden } from '../utils/apiResponse';

export type PermissionAction = 'view' | 'edit' | 'manage';

/**
 * Module-level authorization for ADMIN users.
 * - SUPERADMIN always passes.
 * - ADMIN passes only if the matching AdminPermission flag is set.
 *   Permissions are hierarchical: manage ⇒ edit ⇒ view.
 * - Any other role is forbidden.
 * Must run after requireAuth.
 */
export function requirePermission(module: PermissionModule, action: PermissionAction) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) {
      next(Unauthorized());
      return;
    }

    if (user.role === Role.SUPERADMIN) {
      next();
      return;
    }

    if (user.role !== Role.ADMIN) {
      next(Forbidden());
      return;
    }

    try {
      const perm = await prisma.adminPermission.findUnique({
        where: { userId_module: { userId: user.userId, module } },
      });

      const allowed =
        !!perm &&
        (action === 'view'
          ? perm.canView || perm.canEdit || perm.canManage
          : action === 'edit'
            ? perm.canEdit || perm.canManage
            : perm.canManage);

      if (!allowed) {
        next(Forbidden());
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
