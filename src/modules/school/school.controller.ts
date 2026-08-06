import type { Request, Response } from 'express';
import * as schoolService from './school.service';
import * as storage from '../../services/storage';
import { AppError } from '../../utils/apiResponse';

export async function getBranding(_req: Request, res: Response): Promise<void> {
  const branding = await schoolService.getBranding();
  res.json(branding);
}

export async function getSchool(_req: Request, res: Response): Promise<void> {
  const school = await schoolService.getSchool();
  res.json(school);
}

export async function updateSchool(req: Request, res: Response): Promise<void> {
  const school = await schoolService.updateSchool(req.body, req.user?.userId);
  res.json(school);
}

export async function uploadLogo(req: Request, res: Response): Promise<void> {
  if (!req.file) {
    throw new AppError('No logo file provided (field name: "logo")', 400, 'NO_FILE');
  }
  const path = await storage.uploadFile(req.file.buffer, req.file.originalname, '/logo', req.file.mimetype);
  const school = await schoolService.updateLogo(path, req.user?.userId);
  res.json(school);
}

export async function getSettings(_req: Request, res: Response): Promise<void> {
  const settings = await schoolService.getSettings();
  res.json({ settings });
}

export async function updateSettings(req: Request, res: Response): Promise<void> {
  const settings = await schoolService.updateSettings(req.body.settings, req.user?.userId);
  res.json({ settings });
}

export async function resetAllData(req: Request, res: Response): Promise<void> {
  if (!req.user) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  const result = await schoolService.resetAllSchoolData(req.user);
  res.json(result);
}

export async function getPurgeCounts(_req: Request, res: Response): Promise<void> {
  const counts = await schoolService.getPurgeCounts();
  res.json(counts);
}

export async function purgeBatchData(req: Request, res: Response): Promise<void> {
  if (!req.user) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  const categories: unknown = req.body?.categories;
  if (!Array.isArray(categories) || categories.length === 0 || !categories.every((c) => typeof c === 'string')) {
    throw new AppError('Select at least one category to purge', 400, 'INVALID_CATEGORIES');
  }
  const result = await schoolService.purgeBatchData(req.user, categories as string[]);
  res.json(result);
}

export async function getPurgeItems(_req: Request, res: Response): Promise<void> {
  const items = await schoolService.getPurgeDetailedItems();
  res.json(items);
}

export async function purgeItemsBatch(req: Request, res: Response): Promise<void> {
  if (!req.user) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  const itemsMap: unknown = req.body?.items;
  if (!itemsMap || typeof itemsMap !== 'object') {
    throw new AppError('Provide valid item selection map', 400, 'INVALID_INPUT');
  }
  const result = await schoolService.purgeSelectiveItemsMap(req.user, itemsMap as Record<string, string[]>);
  res.json(result);
}
