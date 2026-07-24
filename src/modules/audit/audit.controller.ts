import type { Request, Response, NextFunction } from 'express';
import { listAuditLogs, seedAuditLogsIfEmpty } from './audit.service';

export async function getAuditLogs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { module, action, actorRole, actorId, startDate, endDate, search, page, limit } = req.query;

    const data = await listAuditLogs({
      module: typeof module === 'string' ? module : undefined,
      action: typeof action === 'string' ? action : undefined,
      actorRole: typeof actorRole === 'string' ? actorRole : undefined,
      actorId: typeof actorId === 'string' ? actorId : undefined,
      startDate: typeof startDate === 'string' ? startDate : undefined,
      endDate: typeof endDate === 'string' ? endDate : undefined,
      search: typeof search === 'string' ? search : undefined,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 30,
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
}

export async function seedAuditLogs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const force = req.query.force === 'true' || req.body?.force === true;
    await seedAuditLogsIfEmpty(force);
    res.json({ message: 'Audit logs seeded successfully' });
  } catch (err) {
    next(err);
  }
}
