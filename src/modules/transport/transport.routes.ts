import { Router } from 'express';
import { PermissionModule } from '@prisma/client';
import * as c from './transport.controller';
import { createRouteSchema, updateRouteSchema, assignSchema, unassignSchema } from './transport.schema';
import { requireAuth } from '../../middleware/requireAuth';
import { requirePermission } from '../../middleware/requirePermission';
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
