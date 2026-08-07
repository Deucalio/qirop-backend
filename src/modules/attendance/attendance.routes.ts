import { Router } from 'express';
import { PermissionModule, Role } from '@prisma/client';
import * as c from './attendance.controller';
import { markSectionSchema, setTeacherAttendanceSchema, markTeachersBatchSchema, createHolidaySchema } from './attendance.schema';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { requirePermission } from '../../middleware/requirePermission';
import { validateBody } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';

const ATT = PermissionModule.ATTENDANCE;
const canView = requirePermission(ATT, 'view');
const canEdit = requirePermission(ATT, 'edit');

// ---- /api/me/teacher/attendance (TEACHER self, READ-ONLY) ----
// Staff attendance is recorded by an admin holding ATTENDANCE edit, so there is
// no self check-in. Teachers may still review their own record.
export const meTeacherAttendanceRouter = Router();
meTeacherAttendanceRouter.use(requireAuth, requireRole(Role.TEACHER));
meTeacherAttendanceRouter.get('/', asyncHandler(c.myTeacherAttendance));

// ---- /api/teachers/:id/attendance (admin set/correct) ----
export const attendanceTeachersRouter = Router();
attendanceTeachersRouter.use(requireAuth);
attendanceTeachersRouter.post('/:id/attendance', canEdit, validateBody(setTeacherAttendanceSchema), asyncHandler(c.setTeacherAttendance));

// ---- /api/teacher-attendance (admin, by date) ----
export const teacherAttendanceRouter = Router();
teacherAttendanceRouter.use(requireAuth, canView);
teacherAttendanceRouter.get('/', asyncHandler(c.listTeacherAttendance));
teacherAttendanceRouter.get('/monthly', asyncHandler(c.listTeachersMonthly));
teacherAttendanceRouter.get('/yearly', asyncHandler(c.listTeachersYearly));
teacherAttendanceRouter.post('/mark', canEdit, validateBody(markTeachersBatchSchema), asyncHandler(c.markTeachersBatch));

// ---- /api/sections/:sectionId/attendance (class teacher or admin) ----
export const sectionAttendanceRouter = Router();
sectionAttendanceRouter.use(requireAuth);
sectionAttendanceRouter.get('/:sectionId/attendance', asyncHandler(c.sectionRoster));
sectionAttendanceRouter.get('/:sectionId/monthly-attendance', asyncHandler(c.sectionMonthly));
sectionAttendanceRouter.post('/:sectionId/attendance', validateBody(markSectionSchema), asyncHandler(c.markSection));

// ---- /api/attendance (admin views + dashboard stats) ----
export const attendanceRouter = Router();
attendanceRouter.use(requireAuth, canView);
attendanceRouter.get('/summary', asyncHandler(c.summary));
attendanceRouter.get('/trend', asyncHandler(c.trend));
attendanceRouter.get('/', asyncHandler(c.byDate));

// ---- /api/me/children (PARENT) ----
export const meChildrenRouter = Router();
meChildrenRouter.use(requireAuth, requireRole(Role.PARENT));
meChildrenRouter.get('/', asyncHandler(c.myChildren));
meChildrenRouter.get('/:studentId/attendance', asyncHandler(c.childAttendance));

// ---- /api/holidays (school calendar) ----
// Anyone who may see attendance may see the calendar; declaring or removing a
// holiday changes what counts as a working day, so it needs edit.
export const holidaysRouter = Router();
holidaysRouter.use(requireAuth);
holidaysRouter.get('/', canView, asyncHandler(c.listHolidays));
holidaysRouter.post('/', canEdit, validateBody(createHolidaySchema), asyncHandler(c.createHoliday));
holidaysRouter.delete('/:id', canEdit, asyncHandler(c.deleteHoliday));
