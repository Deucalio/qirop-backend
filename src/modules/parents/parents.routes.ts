import { Router } from 'express';
import { PermissionModule } from '@prisma/client';
import * as c from './parents.controller';
import { createParentSchema, updateParentSchema, parentStatusSchema, resetPasswordSchema } from './parents.schema';
import { requireAuth } from '../../middleware/requireAuth';
import { requirePermission } from '../../middleware/requirePermission';
import { validateBody } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';

const PARENTS = PermissionModule.PARENTS;
const view = requirePermission(PARENTS, 'view');
const manage = requirePermission(PARENTS, 'manage');

export const parentsRouter = Router();
parentsRouter.use(requireAuth);

parentsRouter.get('/', view, asyncHandler(c.list));
parentsRouter.get('/:id', view, asyncHandler(c.detail));
parentsRouter.post('/', manage, validateBody(createParentSchema), asyncHandler(c.create));
parentsRouter.put('/:id', manage, validateBody(updateParentSchema), asyncHandler(c.update));
parentsRouter.patch('/:id/status', manage, validateBody(parentStatusSchema), asyncHandler(c.updateStatus));
parentsRouter.post('/:id/reset-password', manage, validateBody(resetPasswordSchema), asyncHandler(c.resetPassword));
