import type { Request, Response } from 'express';
import * as studentsService from './students.service';
import { attendanceMonthQuerySchema, listStudentsQuerySchema } from './students.schema';
import { AppError, Unauthorized } from '../../utils/apiResponse';

export async function list(req: Request, res: Response): Promise<void> {
  const query = listStudentsQuerySchema.parse(req.query);
  res.json(await studentsService.listStudents(query));
}

export async function detail(req: Request, res: Response): Promise<void> {
  res.json(await studentsService.getStudent(req.params.id, req.user));
}

export async function attendance(req: Request, res: Response): Promise<void> {
  if (!req.user) throw Unauthorized();
  const { year, month } = attendanceMonthQuerySchema.parse(req.query);
  res.json(await studentsService.getStudentAttendance(req.params.id, req.user, year, month));
}

export async function create(req: Request, res: Response): Promise<void> {
  if (!req.user) throw Unauthorized();
  res.status(201).json(await studentsService.createStudent(req.user, req.body));
}

export async function update(req: Request, res: Response): Promise<void> {
  res.json(await studentsService.updateStudent(req.params.id, req.body, req.user));
}

export async function updateStatus(req: Request, res: Response): Promise<void> {
  res.json(await studentsService.setStatus(req.params.id, req.body.status, req.user));
}

export async function uploadPhoto(req: Request, res: Response): Promise<void> {
  if (!req.file) throw new AppError('No photo file provided (field name: "photo")', 400, 'NO_FILE');
  res.json(await studentsService.setPhoto(req.params.id, req.file.buffer, req.file.originalname, req.file.mimetype, req.user));
}

export async function getAuditLogs(req: Request, res: Response): Promise<void> {
  if (!req.user) throw Unauthorized();
  res.json(await studentsService.getStudentAuditLogs(req.params.id, req.user));
}

export async function purge(req: Request, res: Response): Promise<void> {
  if (!req.user) throw Unauthorized();
  res.json(await studentsService.purgeStudent(req.user, req.params.id));
}
