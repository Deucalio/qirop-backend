import { Router } from 'express';
import { PermissionModule } from '@prisma/client';
import { requireAuth } from '../../middleware/requireAuth';
import { requirePermission } from '../../middleware/requirePermission';
import { getAuditLogs, getAuditLogById, seedAuditLogs } from './audit.controller';

const AUDIT = PermissionModule.AUDIT;

const router = Router();

// The audit trail spans every module — who changed what, everywhere — so it is
// gated on its own AUDIT permission rather than on being an admin. Oversight
// can then be delegated without also handing over user management.
router.use(requireAuth);

router.get('/', requirePermission(AUDIT, 'view'), getAuditLogs);
// Full record on demand: the list view trims bulk payloads (e.g. the students
// billed by a challan generation) to keep page responses small.
router.get('/:id', requirePermission(AUDIT, 'view'), getAuditLogById);
// Seeding rewrites history, so it needs the strongest tier.
router.post('/seed', requirePermission(AUDIT, 'manage'), seedAuditLogs);

export default router;
