import { Router } from 'express';
import { PermissionModule } from '@prisma/client';
import * as c from './students.controller';
import { createStudentSchema, updateStudentSchema, studentStatusSchema } from './students.schema';
import { requireAuth } from '../../middleware/requireAuth';
import { requirePermission } from '../../middleware/requirePermission';
import { validateBody } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { imageUpload } from '../../config/upload';

const STUDENTS = PermissionModule.STUDENTS;
const view = requirePermission(STUDENTS, 'view');
const edit = requirePermission(STUDENTS, 'edit');

export const studentsRouter = Router();
studentsRouter.use(requireAuth);

studentsRouter.get('/', view, asyncHandler(c.list));
studentsRouter.get('/:id', view, asyncHandler(c.detail));
studentsRouter.post('/', edit, validateBody(createStudentSchema), asyncHandler(c.create));
studentsRouter.put('/:id', edit, validateBody(updateStudentSchema), asyncHandler(c.update));
studentsRouter.patch('/:id/status', edit, validateBody(studentStatusSchema), asyncHandler(c.updateStatus));
studentsRouter.post('/:id/photo', edit, imageUpload.single('photo'), asyncHandler(c.uploadPhoto));
