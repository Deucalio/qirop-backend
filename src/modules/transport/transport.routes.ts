import { Router } from 'express';
import { PermissionModule, Role } from '@prisma/client';
import * as c from './transport.controller';
import {
  createRouteSchema,
  updateRouteSchema,
  assignSchema,
  unassignSchema,
  generateTransportChallansSchema,
  patchTransportChallanSchema,
  recordTransportPaymentSchema,
  reverseTransportPaymentSchema,
  markTransportPaidSchema,
  printIdsSchema,
} from './transport.schema';
import { requireAuth } from '../../middleware/requireAuth';
import { requirePermission } from '../../middleware/requirePermission';
import { requireRole } from '../../middleware/requireRole';
import { validateBody } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';

// Transport lives under the FEES module (decision D3 — no separate permission).
const FEES = PermissionModule.FEES;
const view = requirePermission(FEES, 'view');
const edit = requirePermission(FEES, 'edit');
const manage = requirePermission(FEES, 'manage');

export const transportRouter = Router();
transportRouter.use(requireAuth);

transportRouter.get('/summary', view, asyncHandler(c.summary));
transportRouter.get('/routes', view, asyncHandler(c.listRoutes));
transportRouter.post('/routes', edit, validateBody(createRouteSchema), asyncHandler(c.createRoute));
transportRouter.get('/routes/:id', view, asyncHandler(c.getRoute));
transportRouter.put('/routes/:id', edit, validateBody(updateRouteSchema), asyncHandler(c.updateRoute));
transportRouter.delete('/routes/:id', manage, asyncHandler(c.deleteRoute));

transportRouter.put('/assign', edit, validateBody(assignSchema), asyncHandler(c.assign));
transportRouter.delete('/assign', edit, validateBody(unassignSchema), asyncHandler(c.unassign));

// Transport challans — literal paths before `/:id`.
transportRouter.get('/challans/preview', view, asyncHandler(c.challanPreview));
transportRouter.post('/challans/generate', edit, validateBody(generateTransportChallansSchema), asyncHandler(c.generateChallans));
transportRouter.post('/challans/print', view, validateBody(printIdsSchema), asyncHandler(c.printChallans));
transportRouter.post('/challans/mark-paid', edit, validateBody(markTransportPaidSchema), asyncHandler(c.markChallansPaid));
transportRouter.get('/challans', view, asyncHandler(c.listChallans));
transportRouter.get('/challans/:id', view, asyncHandler(c.getChallan));
transportRouter.get('/challans/:id/pdf', view, asyncHandler(c.challanPdf));
transportRouter.patch('/challans/:id', edit, validateBody(patchTransportChallanSchema), asyncHandler(c.patchChallan));
transportRouter.delete('/challans/:id', manage, asyncHandler(c.deleteChallan));

// Transport payments
transportRouter.post('/payments', edit, validateBody(recordTransportPaymentSchema), asyncHandler(c.recordPayment));
transportRouter.get('/payments', view, asyncHandler(c.listPayments));
transportRouter.get('/payments/:id/receipt-pdf', view, asyncHandler(c.paymentReceiptPdf));
transportRouter.post('/payments/:id/reverse', manage, validateBody(reverseTransportPaymentSchema), asyncHandler(c.reversePayment));

// One rider's transport, for the student and staff profile modals.
transportRouter.get('/riders/students/:id', view, asyncHandler(c.studentRiderTransport));
transportRouter.get('/riders/staff/:id', view, asyncHandler(c.staffRiderTransport));

// ---- /api/me/children/:studentId/transport (PARENT) ----
export const meChildTransportRouter = Router();
meChildTransportRouter.use(requireAuth, requireRole(Role.PARENT));
meChildTransportRouter.get('/:studentId/transport', asyncHandler(c.childTransport));
meChildTransportRouter.get('/:studentId/transport-challans/:challanId/pdf', asyncHandler(c.childTransportChallanPdf));

// ---- /api/me/teacher/transport (staff riders) ----
export const meStaffTransportRouter = Router();
meStaffTransportRouter.use(requireAuth, requireRole(Role.TEACHER));
meStaffTransportRouter.get('/', asyncHandler(c.myTransport));
meStaffTransportRouter.get('/challans/:challanId/pdf', asyncHandler(c.myTransportChallanPdf));
