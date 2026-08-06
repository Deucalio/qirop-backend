import { Router } from 'express';
import { PermissionModule } from '@prisma/client';
import * as schoolController from './school.controller';
import { updateSchoolSchema, updateSettingsSchema } from './school.schema';
import { requireAuth } from '../../middleware/requireAuth';
import { requirePermission, requireSuperAdmin } from '../../middleware/requirePermission';
import { validateBody } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { imageUpload } from '../../config/upload';

export const schoolRouter = Router();

schoolRouter.use(requireAuth);

/**
 * Name and logo only, for any signed-in user.
 *
 * The masthead is printed on certificates, ID cards and challans, so anyone who
 * can produce those documents needs it — CERTIFICATES and FEES holders, not
 * just SCHOOL_SETUP. It is also not secret: it goes home with every student.
 * Must stay above `GET /` so the literal path wins the match.
 */
schoolRouter.get('/branding', asyncHandler(schoolController.getBranding));

schoolRouter.get(
  '/',
  requirePermission(PermissionModule.SCHOOL_SETUP, 'view'),
  asyncHandler(schoolController.getSchool),
);

schoolRouter.put(
  '/',
  requirePermission(PermissionModule.SCHOOL_SETUP, 'edit'),
  validateBody(updateSchoolSchema),
  asyncHandler(schoolController.updateSchool),
);

schoolRouter.post(
  '/logo',
  requirePermission(PermissionModule.SCHOOL_SETUP, 'edit'),
  imageUpload.single('logo'),
  asyncHandler(schoolController.uploadLogo),
);

schoolRouter.get(
  '/settings',
  requirePermission(PermissionModule.SCHOOL_SETUP, 'view'),
  asyncHandler(schoolController.getSettings),
);

schoolRouter.put(
  '/settings',
  requirePermission(PermissionModule.SCHOOL_SETUP, 'edit'),
  validateBody(updateSettingsSchema),
  asyncHandler(schoolController.updateSettings),
);

/* -------------------------------------------------------------------------- */
/* Danger Zone Purge Routes — STRICTLY RESTRICTED TO SUPERADMIN             */
/* -------------------------------------------------------------------------- */

schoolRouter.delete(
  '/reset-all',
  requireSuperAdmin,
  asyncHandler(schoolController.resetAllData),
);

schoolRouter.get(
  '/purge-counts',
  requireSuperAdmin,
  asyncHandler(schoolController.getPurgeCounts),
);

schoolRouter.post(
  '/purge-batch',
  requireSuperAdmin,
  asyncHandler(schoolController.purgeBatchData),
);

schoolRouter.get(
  '/purge-items',
  requireSuperAdmin,
  asyncHandler(schoolController.getPurgeItems),
);

schoolRouter.post(
  '/purge-items-batch',
  requireSuperAdmin,
  asyncHandler(schoolController.purgeItemsBatch),
);
