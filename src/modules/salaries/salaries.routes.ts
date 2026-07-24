import { Router } from 'express';
import { PermissionModule } from '@prisma/client';
import * as c from './salaries.controller';
import { generateSalariesSchema, updateSalarySchema, salaryStatusSchema } from './salaries.schema';
import { requireAuth } from '../../middleware/requireAuth';
import { requirePermission } from '../../middleware/requirePermission';
import { validateBody } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';

// Salaries are ADMIN-only: teachers have no SALARIES permission, so every route
// here 403s for them — including their own slip. Salary figures never reach a
// teacher through any endpoint.
const SALARIES = PermissionModule.SALARIES;
const view = requirePermission(SALARIES, 'view');
const edit = requirePermission(SALARIES, 'edit');

export const salariesRouter = Router();
salariesRouter.use(requireAuth);

salariesRouter.get('/my-slips', asyncHandler(c.listMySlips));
salariesRouter.get('/my-slips/:id', asyncHandler(c.getMySlipDetail));

salariesRouter.post('/generate', edit, validateBody(generateSalariesSchema), asyncHandler(c.generate));
salariesRouter.get('/summary', view, asyncHandler(c.summary));
salariesRouter.get('/', view, asyncHandler(c.list));
salariesRouter.get('/:id', view, asyncHandler(c.detail));
salariesRouter.get('/:id/pdf', view, asyncHandler(c.pdf));
salariesRouter.put('/:id', edit, validateBody(updateSalarySchema), asyncHandler(c.update));
salariesRouter.patch('/:id/status', edit, validateBody(salaryStatusSchema), asyncHandler(c.setStatus));
