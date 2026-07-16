import type { Request, Response } from 'express';
import * as svc from './homework.service';
import { teacherHomeworkQuerySchema, adminHomeworkQuerySchema, childHomeworkQuerySchema } from './homework.schema';
import { Unauthorized } from '../../utils/apiResponse';
import type { Actor } from './homework.service';

function actor(req: Request): Actor {
  if (!req.user) throw Unauthorized();
  return { userId: req.user.userId, role: req.user.role };
}

export async function create(req: Request, res: Response): Promise<void> {
  res.status(201).json(await svc.createHomework(actor(req), req.body, req.file));
}
export async function update(req: Request, res: Response): Promise<void> {
  res.json(await svc.updateHomework(actor(req), req.params.id, req.body, req.file));
}
export async function remove(req: Request, res: Response): Promise<void> {
  await svc.deleteHomework(actor(req), req.params.id);
  res.json({ message: 'Homework deleted' });
}
export async function detail(req: Request, res: Response): Promise<void> {
  res.json(await svc.getHomework(actor(req), req.params.id));
}
export async function attachment(req: Request, res: Response): Promise<void> {
  await svc.downloadAttachment(actor(req), req.params.id, res);
}
export async function myTeacher(req: Request, res: Response): Promise<void> {
  const q = teacherHomeworkQuerySchema.parse(req.query);
  res.json(await svc.listMyTeacherHomework(actor(req).userId, q));
}
export async function listAll(req: Request, res: Response): Promise<void> {
  const q = adminHomeworkQuerySchema.parse(req.query);
  res.json(await svc.listAllHomework(q));
}
export async function childHomework(req: Request, res: Response): Promise<void> {
  const q = childHomeworkQuerySchema.parse(req.query);
  res.json(await svc.listChildHomework(actor(req).userId, req.params.studentId, q.from, q.to));
}
