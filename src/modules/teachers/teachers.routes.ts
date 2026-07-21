import { Router } from 'express';
import { PermissionModule, Role } from '@prisma/client';
import * as c from './teachers.controller';
import { createTeacherSchema, updateTeacherSchema, teacherStatusSchema, resetPasswordSchema } from './teachers.schema';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { requirePermission } from '../../middleware/requirePermission';
import { validateBody } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { imageUpload } from '../../config/upload';

const STAFF = PermissionModule.STAFF;
const view = requirePermission(STAFF, 'view');
const manage = requirePermission(STAFF, 'manage');

export const teachersRouter = Router();
teachersRouter.use(requireAuth);

teachersRouter.get('/', view, asyncHandler(c.list));
teachersRouter.get('/:id', view, asyncHandler(c.detail));
teachersRouter.get('/:id/assignments', view, asyncHandler(c.assignments));
teachersRouter.get('/:id/attendance', view, asyncHandler(c.attendance));
teachersRouter.post('/', manage, validateBody(createTeacherSchema), asyncHandler(c.create));
teachersRouter.put('/:id', manage, validateBody(updateTeacherSchema), asyncHandler(c.update));
teachersRouter.patch('/:id/status', manage, validateBody(teacherStatusSchema), asyncHandler(c.updateStatus));
teachersRouter.post('/:id/reset-password', manage, validateBody(resetPasswordSchema), asyncHandler(c.resetPassword));
teachersRouter.post('/:id/photo', manage, imageUpload.single('photo'), asyncHandler(c.uploadPhoto));
teachersRouter.post('/:id/students', manage, asyncHandler(c.linkStudent));

// Teacher self-view: GET /api/me/teacher (TEACHER role only, no salary).
export const meRouter = Router();
meRouter.use(requireAuth);
meRouter.get('/teacher', requireRole(Role.TEACHER), asyncHandler(c.meTeacher));
