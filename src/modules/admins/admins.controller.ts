import type { Request, Response } from 'express';
import * as adminsService from './admins.service';
import { listAdminsQuerySchema } from './admins.schema';
import { AppError, Unauthorized } from '../../utils/apiResponse';
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

export async function detachStaffProfile(req: Request, res: Response): Promise<void> {
  res.json(await adminsService.detachStaffProfile(getActor(req), req.params.id));
}

export async function attachStaffProfile(req: Request, res: Response): Promise<void> {
  res.status(201).json(await adminsService.attachStaffProfile(getActor(req), req.params.id, req.body));
}

export async function uploadAvatar(req: Request, res: Response): Promise<void> {
  if (!req.file) throw new AppError('No image uploaded', 400, 'NO_FILE');
  res.json(
    await adminsService.setAvatar(
      getActor(req),
      req.params.id,
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
    ),
  );
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  await adminsService.resetPassword(getActor(req), req.params.id, req.body.newPassword);
  res.json({ message: 'Password reset successfully' });
}

export async function updateStatus(req: Request, res: Response): Promise<void> {
  res.json(await adminsService.updateStatus(getActor(req), req.params.id, req.body.status));
}

export async function remove(req: Request, res: Response): Promise<void> {
  await adminsService.deleteAdmin(getActor(req), req.params.id);
  res.json({ message: 'User account deleted successfully' });
}
