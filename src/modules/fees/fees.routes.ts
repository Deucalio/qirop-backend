import { Router } from 'express';
import { PermissionModule, Role } from '@prisma/client';
import * as c from './fees.controller';
import {
  setFeeStructureSchema,
  setDiscountSchema,
  generateChallansSchema,
  patchChallanSchema,
  recordPaymentSchema,
  reversePaymentSchema,
  markPaidSchema,
} from './fees.schema';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { requirePermission } from '../../middleware/requirePermission';
import { validateBody } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';

const FEES = PermissionModule.FEES;
const view = requirePermission(FEES, 'view');
const edit = requirePermission(FEES, 'edit');
const manage = requirePermission(FEES, 'manage');

// ---- /api/fee-structures ----
export const feeStructuresRouter = Router();
feeStructuresRouter.use(requireAuth);
feeStructuresRouter.get('/', view, asyncHandler(c.listFeeStructures));
feeStructuresRouter.put('/:classId', edit, validateBody(setFeeStructureSchema), asyncHandler(c.setFeeStructure));

// ---- /api/fees ----
export const feesRouter = Router();
feesRouter.use(requireAuth);

feesRouter.post('/challans/generate', edit, validateBody(generateChallansSchema), asyncHandler(c.generateChallans));
feesRouter.get('/challans/generate-preview', view, asyncHandler(c.generatePreview));
feesRouter.get('/challans', view, asyncHandler(c.listChallans));
feesRouter.post('/challans/mark-overdue', edit, asyncHandler(c.markOverdue));
feesRouter.post('/challans/mark-paid', edit, validateBody(markPaidSchema), asyncHandler(c.markPaid));
feesRouter.post('/challans/print', view, asyncHandler(c.challansPdfBatch));
feesRouter.get('/challans/:id', view, asyncHandler(c.getChallan));
feesRouter.get('/challans/:id/pdf', view, asyncHandler(c.challanPdf));
feesRouter.patch('/challans/:id', edit, validateBody(patchChallanSchema), asyncHandler(c.patchChallan));
feesRouter.delete('/challans/:id', manage, asyncHandler(c.deleteChallan));

feesRouter.post('/payments', edit, validateBody(recordPaymentSchema), asyncHandler(c.recordPayment));
feesRouter.get('/payments', view, asyncHandler(c.listPayments));
feesRouter.post('/payments/:id/reverse', manage, validateBody(reversePaymentSchema), asyncHandler(c.reversePayment));

feesRouter.get('/summary', view, asyncHandler(c.feesSummary));
feesRouter.get('/trend', view, asyncHandler(c.feesTrend));

// ---- student discount + ledger (mounted under /api/students) ----
export const studentFeesRouter = Router();
studentFeesRouter.use(requireAuth);
studentFeesRouter.put('/:id/discount', edit, validateBody(setDiscountSchema), asyncHandler(c.setStudentDiscount));
studentFeesRouter.get('/:id/fee-ledger', view, asyncHandler(c.studentLedger));

// ---- parent view (mounted under /api/me/children) ----
export const meChildFeesRouter = Router();
meChildFeesRouter.use(requireAuth, requireRole(Role.PARENT));
meChildFeesRouter.get('/:studentId/fees', asyncHandler(c.childFees));
// Parents can print/see the issued challan itself, not just the numbers.
meChildFeesRouter.get('/:studentId/challans/:challanId/pdf', asyncHandler(c.parentChallanPdf));

// ---- staff-parent view (decision D4, mounted under /api/me/teacher/children) ----
// A teacher sees their own children's fees + attendance. No salary data is
// reachable from any of these routes.
export const meTeacherChildrenRouter = Router();
meTeacherChildrenRouter.use(requireAuth, requireRole(Role.TEACHER));
meTeacherChildrenRouter.get('/', asyncHandler(c.myStaffChildren));
meTeacherChildrenRouter.get('/:studentId/fees', asyncHandler(c.myStaffChildFees));
meTeacherChildrenRouter.get('/:studentId/challans/:challanId/pdf', asyncHandler(c.teacherChildChallanPdf));
