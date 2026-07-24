import { Router } from 'express';
import { Role } from '@prisma/client';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { getAuditLogs, seedAuditLogs } from './audit.controller';

const router = Router();

// History / Audit Logs page is restricted to SUPERADMIN and ADMIN
router.use(requireAuth);
router.use(requireRole(Role.SUPERADMIN, Role.ADMIN));

router.get('/', getAuditLogs);
router.post('/seed', seedAuditLogs);

export default router;
