import type { Request, Response } from 'express';
import * as adminsService from './admins.service';
import { listAdminsQuerySchema } from './admins.schema';
import { Unauthorized } from '../../utils/apiResponse';
import type { Actor } from './admins.service';

function getActor(req: Request): Actor {
  if (!req.user) throw Unauthorized();
  return { userId: req.user.userId, role: req.user.role };
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = listAdminsQuerySchema.parse(req.query);
  res.json(await adminsService.listAdmins(query));
}

export async function detail(req: Request, res: Response): Promise<void> {
  res.json(await adminsService.getAdmin(req.params.id));
}

export async function create(req: Request, res: Response): Promise<void> {
  res.status(201).json(await adminsService.createAdmin(getActor(req), req.body));
}

export async function update(req: Request, res: Response): Promise<void> {
  res.json(await adminsService.updateAdmin(getActor(req), req.params.id, req.body));
}

export async function updatePermissions(req: Request, res: Response): Promise<void> {
  res.json(await adminsService.replacePermissions(getActor(req), req.params.id, req.body.permissions));
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  await adminsService.resetPassword(getActor(req), req.params.id, req.body.newPassword);
  res.json({ message: 'Password reset successfully' });
}

export async function updateStatus(req: Request, res: Response): Promise<void> {
  res.json(await adminsService.updateStatus(getActor(req), req.params.id, req.body.status));
}
