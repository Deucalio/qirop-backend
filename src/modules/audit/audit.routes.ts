import { Router } from 'express';
import { PermissionModule } from '@prisma/client';
import { requireAuth } from '../../middleware/requireAuth';
import { requirePermission } from '../../middleware/requirePermission';
import { getAuditLogs, seedAuditLogs } from './audit.controller';

const AUDIT = PermissionModule.AUDIT;

const router = Router();

// The audit trail spans every module — who changed what, everywhere — so it is
// gated on its own AUDIT permission rather than on being an admin. Oversight
// can then be delegated without also handing over user management.
router.use(requireAuth);

router.get('/', requirePermission(AUDIT, 'view'), getAuditLogs);
// Seeding rewrites history, so it needs the strongest tier.
router.post('/seed', requirePermission(AUDIT, 'manage'), seedAuditLogs);

export default router;
