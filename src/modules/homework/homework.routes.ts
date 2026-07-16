import { Router } from 'express';
import { PermissionModule, Role } from '@prisma/client';
import * as c from './homework.controller';
import { createHomeworkSchema, updateHomeworkSchema } from './homework.schema';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { requirePermission } from '../../middleware/requirePermission';
import { validateBody } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { attachmentUpload } from '../../config/upload';

const HOMEWORK = PermissionModule.HOMEWORK;

// ---- /api/homework ----
export const homeworkRouter = Router();
homeworkRouter.use(requireAuth);

// Admin school-wide view (teachers use /api/me/teacher/homework).
homeworkRouter.get('/', requirePermission(HOMEWORK, 'view'), asyncHandler(c.listAll));
// Create: authorization (teacher-assignment or admin) is enforced in the service.
homeworkRouter.post('/', attachmentUpload.single('file'), validateBody(createHomeworkSchema), asyncHandler(c.create));
homeworkRouter.get('/:id', asyncHandler(c.detail));
homeworkRouter.get('/:id/attachment', asyncHandler(c.attachment));
homeworkRouter.put('/:id', attachmentUpload.single('file'), validateBody(updateHomeworkSchema), asyncHandler(c.update));
homeworkRouter.delete('/:id', asyncHandler(c.remove));

// ---- /api/me/teacher/homework (TEACHER) ----
export const meTeacherHomeworkRouter = Router();
meTeacherHomeworkRouter.use(requireAuth, requireRole(Role.TEACHER));
meTeacherHomeworkRouter.get('/', asyncHandler(c.myTeacher));

// ---- /api/me/children/:studentId/homework (PARENT) ----
export const meChildHomeworkRouter = Router();
meChildHomeworkRouter.use(requireAuth, requireRole(Role.PARENT));
meChildHomeworkRouter.get('/:studentId/homework', asyncHandler(c.childHomework));
