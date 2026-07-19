import { Router } from 'express';
import { PermissionModule, Role } from '@prisma/client';
import * as c from './timetable.controller';
import {
  setSlotSchema,
  setValiditySchema,
  saveTimetableConfigSchema,
  markPeriodAttendanceSchema,
} from './timetable.schema';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { requirePermission } from '../../middleware/requirePermission';
import { validateBody } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';

const timetableView = requirePermission(PermissionModule.TIMETABLE, 'view');
const timetableEdit = requirePermission(PermissionModule.TIMETABLE, 'edit');
const attendanceView = requirePermission(PermissionModule.ATTENDANCE, 'view');
const attendanceEdit = requirePermission(PermissionModule.ATTENDANCE, 'edit');

// ---- /api/timetable-config (school-wide period & break timings) ----
export const timetableConfigRouter = Router();
timetableConfigRouter.use(requireAuth);
// Any authenticated user may read the layout (the grid needs it); only
// TIMETABLE editors may change it, since doing so can drop scheduled periods.
timetableConfigRouter.get('/', asyncHandler(c.timetableConfig));
timetableConfigRouter.put(
  '/',
  timetableEdit,
  validateBody(saveTimetableConfigSchema),
  asyncHandler(c.saveTimetableConfig),
);

// ---- /api/sections/:sectionId/timetable (admin, module TIMETABLE) ----
export const sectionTimetableRouter = Router();
sectionTimetableRouter.use(requireAuth);
sectionTimetableRouter.get('/:sectionId/timetable', timetableView, asyncHandler(c.sectionTimetable));
sectionTimetableRouter.put('/:sectionId/timetable/slot', timetableEdit, validateBody(setSlotSchema), asyncHandler(c.setSlot));
sectionTimetableRouter.put(
  '/:sectionId/timetable/validity',
  timetableEdit,
  validateBody(setValiditySchema),
  asyncHandler(c.setValidity),
);

// ---- /api/sections/:sectionId/period-attendance (admin, module ATTENDANCE) ----
export const periodAttendanceRouter = Router();
periodAttendanceRouter.use(requireAuth);
periodAttendanceRouter.get('/:sectionId/period-attendance', attendanceView, asyncHandler(c.sectionPeriodAttendance));
periodAttendanceRouter.post(
  '/:sectionId/period-attendance',
  attendanceEdit,
  validateBody(markPeriodAttendanceSchema),
  asyncHandler(c.markPeriodAttendance),
);

// ---- /api/me/teacher/timetable (TEACHER self) ----
export const meTeacherTimetableRouter = Router();
meTeacherTimetableRouter.use(requireAuth, requireRole(Role.TEACHER));
meTeacherTimetableRouter.get('/', asyncHandler(c.meTeacherTimetable));

// ---- /api/me/children/:studentId/timetable (PARENT) ----
export const meChildTimetableRouter = Router();
meChildTimetableRouter.use(requireAuth, requireRole(Role.PARENT));
meChildTimetableRouter.get('/:studentId/timetable', asyncHandler(c.childTimetable));
