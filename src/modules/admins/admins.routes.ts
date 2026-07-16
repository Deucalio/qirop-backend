import { Router } from 'express';
import { PermissionModule } from '@prisma/client';
import * as adminsController from './admins.controller';
import {
  createAdminSchema,
  updateAdminSchema,
  updatePermissionsSchema,
  resetPasswordSchema,
  updateStatusSchema,
} from './admins.schema';
import { requireAuth } from '../../middleware/requireAuth';
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
  requirePermission(USERS, 'manage'),
  validateBody(createAdminSchema),
  asyncHandler(adminsController.create),
);

adminsRouter.put(
  '/:id',
  requirePermission(USERS, 'manage'),
  validateBody(updateAdminSchema),
  asyncHandler(adminsController.update),
);

adminsRouter.put(
  '/:id/permissions',
  requirePermission(USERS, 'manage'),
  validateBody(updatePermissionsSchema),
  asyncHandler(adminsController.updatePermissions),
);

adminsRouter.post(
  '/:id/reset-password',
  requirePermission(USERS, 'manage'),
  validateBody(resetPasswordSchema),
  asyncHandler(adminsController.resetPassword),
);

adminsRouter.patch(
  '/:id/status',
  requirePermission(USERS, 'manage'),
  validateBody(updateStatusSchema),
  asyncHandler(adminsController.updateStatus),
);
