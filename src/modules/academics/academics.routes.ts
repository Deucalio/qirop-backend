import { Router } from 'express';
import { PermissionModule } from '@prisma/client';
import * as c from './academics.controller';
import {
  createClassSchema,
  updateClassSchema,
  createSectionSchema,
  updateSectionSchema,
  createSubjectSchema,
  updateSubjectSchema,
  setClassSubjectsSchema,
} from './academics.schema';
import { requireAuth } from '../../middleware/requireAuth';
import { requirePermission } from '../../middleware/requirePermission';
import { validateBody } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';

const CLASSES = PermissionModule.CLASSES;
const canView = requirePermission(CLASSES, 'view');
const canEdit = requirePermission(CLASSES, 'edit');

// ---- /api/classes (+ nested sections & subject mapping) ----
export const classesRouter = Router();
classesRouter.use(requireAuth);

classesRouter.get('/', canView, asyncHandler(c.listClasses));
classesRouter.post('/', canEdit, validateBody(createClassSchema), asyncHandler(c.createClass));
classesRouter.put('/:id', canEdit, validateBody(updateClassSchema), asyncHandler(c.updateClass));
classesRouter.delete('/:id', canEdit, asyncHandler(c.deleteClass));

classesRouter.get('/:classId/sections', canView, asyncHandler(c.listSections));
classesRouter.post('/:classId/sections', canEdit, validateBody(createSectionSchema), asyncHandler(c.createSection));

classesRouter.get('/:classId/subjects', canView, asyncHandler(c.getClassSubjects));
classesRouter.put('/:classId/subjects', canEdit, validateBody(setClassSubjectsSchema), asyncHandler(c.setClassSubjects));

// ---- /api/sections ----
export const sectionsRouter = Router();
sectionsRouter.use(requireAuth);

sectionsRouter.put('/:id', canEdit, validateBody(updateSectionSchema), asyncHandler(c.updateSection));
sectionsRouter.delete('/:id', canEdit, asyncHandler(c.deleteSection));

// ---- /api/subjects ----
export const subjectsRouter = Router();
subjectsRouter.use(requireAuth);

subjectsRouter.get('/', canView, asyncHandler(c.listSubjects));
subjectsRouter.get('/:id/details', canView, asyncHandler(c.subjectDetails));
subjectsRouter.post('/', canEdit, validateBody(createSubjectSchema), asyncHandler(c.createSubject));
subjectsRouter.put('/:id', canEdit, validateBody(updateSubjectSchema), asyncHandler(c.updateSubject));
subjectsRouter.delete('/:id', canEdit, asyncHandler(c.deleteSubject));
