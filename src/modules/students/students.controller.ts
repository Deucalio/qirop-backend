import type { Request, Response } from 'express';
import * as studentsService from './students.service';
import { listStudentsQuerySchema } from './students.schema';
import { AppError, Unauthorized } from '../../utils/apiResponse';

export async function list(req: Request, res: Response): Promise<void> {
  const query = listStudentsQuerySchema.parse(req.query);
  res.json(await studentsService.listStudents(query));
}

export async function detail(req: Request, res: Response): Promise<void> {
  res.json(await studentsService.getStudent(req.params.id));
}

export async function create(req: Request, res: Response): Promise<void> {
  if (!req.user) throw Unauthorized();
  res.status(201).json(await studentsService.createStudent(req.user.userId, req.body));
}

export async function update(req: Request, res: Response): Promise<void> {
  res.json(await studentsService.updateStudent(req.params.id, req.body));
}

export async function updateStatus(req: Request, res: Response): Promise<void> {
  res.json(await studentsService.setStatus(req.params.id, req.body.status));
}

export async function uploadPhoto(req: Request, res: Response): Promise<void> {
  if (!req.file) throw new AppError('No photo file provided (field name: "photo")', 400, 'NO_FILE');
  res.json(await studentsService.setPhoto(req.params.id, req.file.buffer, req.file.originalname, req.file.mimetype));
}
