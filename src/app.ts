import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { Role } from '@prisma/client';
import { env } from './config/env';
import { prisma } from './config/prisma';
import { authRouter } from './modules/auth/auth.routes';
import { schoolRouter } from './modules/school/school.routes';
import { adminsRouter } from './modules/admins/admins.routes';
import { classesRouter, sectionsRouter, subjectsRouter } from './modules/academics/academics.routes';
import { teachersRouter, meRouter } from './modules/teachers/teachers.routes';
import {
  timetableConfigRouter,
  sectionTimetableRouter,
  periodAttendanceRouter,
  meTeacherTimetableRouter,
  meChildTimetableRouter,
} from './modules/timetable/timetable.routes';
import { parentsRouter } from './modules/parents/parents.routes';
import { studentsRouter } from './modules/students/students.routes';
import {
  assignmentSectionsRouter,
  teachingAssignmentsRouter,
} from './modules/assignments/assignments.routes';
import {
  meTeacherAttendanceRouter,
  attendanceTeachersRouter,
  teacherAttendanceRouter,
  sectionAttendanceRouter,
  attendanceRouter,
  meChildrenRouter,
} from './modules/attendance/attendance.routes';
import {
  homeworkRouter,
  meTeacherHomeworkRouter,
  meChildHomeworkRouter,
} from './modules/homework/homework.routes';
import {
  feeStructuresRouter,
  feesRouter,
  studentFeesRouter,
  meChildFeesRouter,
  meTeacherChildrenRouter,
} from './modules/fees/fees.routes';
import { transportRouter } from './modules/transport/transport.routes';
import { salariesRouter } from './modules/salaries/salaries.routes';
import { expensesRouter, financeRouter } from './modules/expenses/expenses.routes';
import { requireAuth } from './middleware/requireAuth';
import { requireRole } from './middleware/requireRole';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

export function createApp(): Express {
  const app = express();

  // Security & parsing. Allow cross-origin embedding of static assets (logos,
  // avatars) so the frontend on a different origin can load /uploads images.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: env.CLIENT_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Health check — verifies DB connectivity.
  app.get('/api/health', async (_req: Request, res: Response) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'error', db: 'disconnected' });
    }
  });


  app.get("/api/health-two", async (_req: Request, res: Response) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok-two', db: 'connected-two', timestamp: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'error', db: 'disconnected' });
    }
  });


  // Feature routers
  app.use('/api/auth', authRouter);
  app.use('/api/school', schoolRouter);
  app.use('/api/admins', adminsRouter);
  app.use('/api/classes', classesRouter);
  app.use('/api/sections', sectionsRouter);
  app.use('/api/sections', assignmentSectionsRouter); // class-teacher + teaching-assignments (STAFF)
  app.use('/api/sections', sectionAttendanceRouter); // student attendance roster/marking (ATTENDANCE)
  app.use('/api/timetable-config', timetableConfigRouter); // school-wide period & break timings
  app.use('/api/sections', sectionTimetableRouter); // weekly timetable grid (TIMETABLE)
  app.use('/api/sections', periodAttendanceRouter); // per-period teacher attendance (ATTENDANCE)
  app.use('/api/subjects', subjectsRouter);
  app.use('/api/teachers', teachersRouter);
  app.use('/api/teachers', attendanceTeachersRouter); // admin set/correct teacher attendance
  app.use('/api/parents', parentsRouter);
  app.use('/api/students', studentsRouter);
  app.use('/api/students', studentFeesRouter); // per-student discount + fee ledger (FEES)
  app.use('/api/fee-structures', feeStructuresRouter);
  app.use('/api/fees', feesRouter);
  app.use('/api/transport', transportRouter);
  app.use('/api/salaries', salariesRouter);
  app.use('/api/expenses', expensesRouter);
  app.use('/api/finance', financeRouter);
  app.use('/api/teaching-assignments', teachingAssignmentsRouter);
  app.use('/api/teacher-attendance', teacherAttendanceRouter);
  app.use('/api/attendance', attendanceRouter);
  app.use('/api/homework', homeworkRouter);
  app.use('/api/me/teacher/attendance', meTeacherAttendanceRouter);
  app.use('/api/me/teacher/homework', meTeacherHomeworkRouter);
  app.use('/api/me/teacher/timetable', meTeacherTimetableRouter);
  app.use('/api/me/teacher/children', meTeacherChildrenRouter); // staff-parent fee view (D4)
  app.use('/api/me/children', meChildrenRouter);
  app.use('/api/me/children', meChildHomeworkRouter);
  app.use('/api/me/children', meChildTimetableRouter);
  app.use('/api/me/children', meChildFeesRouter);
  app.use('/api/me', meRouter);

  // Protected test route to verify RBAC.
  app.get(
    '/api/admin/ping',
    requireAuth,
    requireRole(Role.SUPERADMIN, Role.ADMIN),
    (req: Request, res: Response) => {
      res.json({ message: 'pong', role: req.user?.role });
    },
  );

  // 404 + error handler (must be last).
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
