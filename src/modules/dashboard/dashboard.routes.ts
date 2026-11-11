import { Router, type Request, type Response } from 'express';
import { PermissionModule, Role } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { requireAuth } from '../../middleware/requireAuth';
import { requirePermission } from '../../middleware/requirePermission';
import { asyncHandler } from '../../utils/asyncHandler';
import { dashboardFinance } from './dashboard.service';

/** Whether this user may see a module — spending is shown only to those who may see expenses. */
async function mayView(req: Request, module: PermissionModule): Promise<boolean> {
  if (!req.user) return false;
  if (req.user.role === Role.SUPERADMIN) return true;
  const p = await prisma.adminPermission.findUnique({ where: { userId_module: { userId: req.user.userId, module } } });
  return !!p && (p.canView || p.canEdit || p.canManage);
}

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

/** Money received, money spent, and what is owed — the dashboard's finance cards. Gated by FEES view. */
dashboardRouter.get(
  '/finance',
  requirePermission(PermissionModule.FEES, 'view'),
  asyncHandler(async (req: Request, res: Response) => {
    const months = req.query.months ? Number(req.query.months) : undefined;
    const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : undefined;
    const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : undefined;
    res.json(await dashboardFinance({ months, startDate, endDate }, { spending: await mayView(req, PermissionModule.EXPENSES) }));
  }),
);
