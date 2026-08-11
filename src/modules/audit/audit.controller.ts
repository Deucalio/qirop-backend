import type { Request, Response, NextFunction } from 'express';
import { listAuditLogs, seedAuditLogsIfEmpty, getAuditLog } from './audit.service';

/** Full record, including payloads the list view trims for size. */
export async function getAuditLogById(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const log = await getAuditLog(req.params.id);
    if (!log) {
      res.status(404).json({ message: 'Audit record not found' });
      return;
    }
    res.json(log);
  } catch (err) {
    next(err);
  }
}

export async function getAuditLogs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { module, action, actorRole, actorId, startDate, endDate, search, page, limit, full } = req.query;

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
      // Exports ask for this; the browsing UI never does.
      full: full === '1' || full === 'true',
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
