import { Router } from 'express';
import { PermissionModule } from '@prisma/client';
import * as c from './assignments.controller';
import {
  setClassTeacherSchema,
  upsertTeachingAssignmentSchema,
  deleteTeachingAssignmentSchema,
} from './assignments.schema';
import { requireAuth } from '../../middleware/requireAuth';
import { requirePermission } from '../../middleware/requirePermission';
import { validateBody } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';

const STAFF = PermissionModule.STAFF;
const view = requirePermission(STAFF, 'view');
const edit = requirePermission(STAFF, 'edit');

// Mounted at /api/sections (alongside the academics sections router).
export const assignmentSectionsRouter = Router();
assignmentSectionsRouter.use(requireAuth);
assignmentSectionsRouter.put('/:id/class-teacher', edit, validateBody(setClassTeacherSchema), asyncHandler(c.setClassTeacher));
assignmentSectionsRouter.get('/:sectionId/teaching-assignments', view, asyncHandler(c.getSectionAssignments));

// Mounted at /api/teaching-assignments.
export const teachingAssignmentsRouter = Router();
teachingAssignmentsRouter.use(requireAuth);
teachingAssignmentsRouter.put('/', edit, validateBody(upsertTeachingAssignmentSchema), asyncHandler(c.upsertTeachingAssignment));
teachingAssignmentsRouter.delete('/', edit, validateBody(deleteTeachingAssignmentSchema), asyncHandler(c.deleteTeachingAssignment));
