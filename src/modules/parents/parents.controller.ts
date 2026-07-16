import type { Request, Response } from 'express';
import * as parentsService from './parents.service';
import { listParentsQuerySchema } from './parents.schema';
import { Unauthorized } from '../../utils/apiResponse';

export async function list(req: Request, res: Response): Promise<void> {
  const query = listParentsQuerySchema.parse(req.query);
  res.json(await parentsService.listParents(query));
}

export async function detail(req: Request, res: Response): Promise<void> {
  res.json(await parentsService.getParent(req.params.id));
}

export async function create(req: Request, res: Response): Promise<void> {
  if (!req.user) throw Unauthorized();
  res.status(201).json(await parentsService.createParent(req.user.userId, req.body));
}

export async function update(req: Request, res: Response): Promise<void> {
  res.json(await parentsService.updateParent(req.params.id, req.body));
}

export async function updateStatus(req: Request, res: Response): Promise<void> {
  res.json(await parentsService.setStatus(req.params.id, req.body.status));
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  await parentsService.resetPassword(req.params.id, req.body.newPassword);
  res.json({ message: 'Password reset successfully' });
}
