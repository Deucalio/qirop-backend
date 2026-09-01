import { Router } from 'express';
import { PermissionModule } from '@prisma/client';
import * as c from './certificates.controller';
import { setCertificateFeeSchema, recordIssueSchema } from './certificates.schema';
import { requireAuth } from '../../middleware/requireAuth';
import { requirePermission } from '../../middleware/requirePermission';
import { validateBody } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';

const CERTS = PermissionModule.CERTIFICATES;
const view = requirePermission(CERTS, 'view');
/*
 * Setting a price and recording a charge are money decisions, so they sit
 * behind FEES edit rather than CERTIFICATES edit: whoever can issue a document
 * is not automatically whoever can decide what the school charges for it.
 */
const chargeable = requirePermission(PermissionModule.FEES, 'edit');

export const certificatesRouter = Router();
certificatesRouter.use(requireAuth);

certificatesRouter.get('/fees', view, asyncHandler(c.listFees));
certificatesRouter.put('/fees/:kind', chargeable, validateBody(setCertificateFeeSchema), asyncHandler(c.setFee));
certificatesRouter.get('/issues', view, asyncHandler(c.listIssues));
certificatesRouter.get('/summary', view, asyncHandler(c.summary));
certificatesRouter.post('/issues', chargeable, validateBody(recordIssueSchema), asyncHandler(c.recordIssue));
