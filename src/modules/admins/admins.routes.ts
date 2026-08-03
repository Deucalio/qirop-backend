import { Router } from 'express';
import { PermissionModule, Role } from '@prisma/client';
import * as adminsController from './admins.controller';
import {
  createAdminSchema,
  updateAdminSchema,
  updatePermissionsSchema,
  resetPasswordSchema,
  updateStatusSchema,
} from './admins.schema';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { requirePermission } from '../../middleware/requirePermission';
import { validateBody } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';

const USERS = PermissionModule.USERS;

export const adminsRouter = Router();

adminsRouter.use(requireAuth);

adminsRouter.get('/', requirePermission(USERS, 'view'), asyncHandler(adminsController.list));
adminsRouter.get('/:id', requirePermission(USERS, 'view'), asyncHandler(adminsController.detail));

adminsRouter.post(
  '/',
  requireRole(Role.SUPERADMIN),
  validateBody(createAdminSchema),
  asyncHandler(adminsController.create),
);

adminsRouter.put(
  '/:id',
  requireRole(Role.SUPERADMIN),
  validateBody(updateAdminSchema),
  asyncHandler(adminsController.update),
);

adminsRouter.put(
  '/:id/permissions',
  requireRole(Role.SUPERADMIN),
  validateBody(updatePermissionsSchema),
  asyncHandler(adminsController.updatePermissions),
);

adminsRouter.post(
  '/:id/reset-password',
  requireRole(Role.SUPERADMIN),
  validateBody(resetPasswordSchema),
  asyncHandler(adminsController.resetPassword),
);

adminsRouter.patch(
  '/:id/status',
  requireRole(Role.SUPERADMIN),
  validateBody(updateStatusSchema),
  asyncHandler(adminsController.updateStatus),
);

adminsRouter.delete(
  '/:id',
  requireRole(Role.SUPERADMIN),
  asyncHandler(adminsController.remove),
);
