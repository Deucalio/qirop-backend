import { Router } from 'express';
import { PermissionModule, Role } from '@prisma/client';
import * as adminsController from './admins.controller';
import {
  createAdminSchema,
  updateAdminSchema,
  updatePermissionsSchema,
  resetPasswordSchema,
  updateStatusSchema,
  staffProfileSchema,
} from './admins.schema';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { requirePermission } from '../../middleware/requirePermission';
import { validateBody } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { imageUpload } from '../../config/upload';

/**
 * These reads are gated on STAFF, not the retired USERS module.
 *
 * User management moved onto the Staff page's "Admins & System Roles" tab when
 * the standalone Users & Roles page was removed, so STAFF is where the
 * capability now lives. USERS is no longer offered in the permission matrix,
 * which meant gating on it left non-superadmins with a dead end: they couldn't
 * open the permissions dialog and couldn't be granted the module to fix it.
 * Writes below stay SUPERADMIN-only regardless.
 */
const STAFF = PermissionModule.STAFF;

export const adminsRouter = Router();

adminsRouter.use(requireAuth);

adminsRouter.get('/', requirePermission(STAFF, 'view'), asyncHandler(adminsController.list));
adminsRouter.get('/:id', requirePermission(STAFF, 'view'), asyncHandler(adminsController.detail));

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

// Profile picture — stored on User.avatarUrl, so it works with or without a
// staff profile (the /teachers photo route needs one).
adminsRouter.post(
  '/:id/avatar',
  requireRole(Role.SUPERADMIN),
  imageUpload.single('photo'),
  asyncHandler(adminsController.uploadAvatar),
);

// Backfill a staff record onto a login-only account so it joins the payroll.
adminsRouter.post(
  '/:id/staff-profile',
  requireRole(Role.SUPERADMIN),
  validateBody(staffProfileSchema),
  asyncHandler(adminsController.attachStaffProfile),
);

// Take them off payroll without touching their login or permissions.
adminsRouter.delete(
  '/:id/staff-profile',
  requireRole(Role.SUPERADMIN),
  asyncHandler(adminsController.detachStaffProfile),
);

adminsRouter.delete(
  '/:id',
  requireRole(Role.SUPERADMIN),
  asyncHandler(adminsController.remove),
);
