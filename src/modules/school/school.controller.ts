import type { Request, Response } from 'express';
import * as schoolService from './school.service';
import * as storage from '../../services/storage';
import { AppError } from '../../utils/apiResponse';

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
