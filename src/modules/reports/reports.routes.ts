import { Router } from 'express';
import { PermissionModule } from '@prisma/client';
import * as c from './reports.controller';
import { requireAuth } from '../../middleware/requireAuth';
import { requirePermission } from '../../middleware/requirePermission';
import { asyncHandler } from '../../utils/asyncHandler';

const view = requirePermission(PermissionModule.REPORTS, 'view');

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

reportsRouter.get('/students/roster', view, asyncHandler(c.studentRoster));
reportsRouter.get('/students/defaulters', view, asyncHandler(c.feeDefaulters));

reportsRouter.get('/attendance/student-summary', view, asyncHandler(c.studentAttendanceSummary));
reportsRouter.get('/attendance/staff-summary', view, asyncHandler(c.staffAttendanceSummary));
reportsRouter.get('/attendance/daily-absentees', view, asyncHandler(c.dailyAbsentees));

reportsRouter.get('/finance/fee-collections', view, asyncHandler(c.feeCollectionsAudit));
reportsRouter.get('/finance/expenses-audit', view, asyncHandler(c.expenseLedgerAudit));
reportsRouter.get('/finance/payroll-register', view, asyncHandler(c.payrollRegister));
