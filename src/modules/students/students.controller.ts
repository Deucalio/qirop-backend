import type { Request, Response } from 'express';
import * as studentsService from './students.service';
import { attendanceMonthQuerySchema, listStudentsQuerySchema, createStudentSchema } from './students.schema';
import { AppError, Unauthorized } from '../../utils/apiResponse';

export async function list(req: Request, res: Response): Promise<void> {
  const query = listStudentsQuerySchema.parse(req.query);
  res.json(await studentsService.listStudents(query, req.user));
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

  let body = req.body;
  if (typeof body.parent === 'string') {
    try {
      body.parent = JSON.parse(body.parent);
    } catch {}
  }

  const input = createStudentSchema.parse(body);
  const student = await studentsService.createStudent(req.user, input);

  if (req.file) {
    const result = await studentsService.setPhoto(
      student.id,
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      req.user,
    );
    res.status(201).json(result);
    return;
  }

  res.status(201).json(student);
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

export async function uploadDocument(req: Request, res: Response): Promise<void> {
  if (!req.user) throw Unauthorized();
  if (!req.file) throw new AppError('No file provided (field name: "file")', 400, 'NO_FILE');
  const label = req.body.label || 'Document';
  res.status(201).json(
    await studentsService.addDocument(
      req.params.id,
      label,
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      req.user,
    ),
  );
}

export async function deleteDocument(req: Request, res: Response): Promise<void> {
  if (!req.user) throw Unauthorized();
  res.json(await studentsService.removeDocument(req.params.id, req.params.docId, req.user));
}

export async function downloadDocument(req: Request, res: Response): Promise<void> {
  const disposition = (req.query.disposition as 'inline' | 'attachment') || 'attachment';
  await studentsService.downloadDocument(req.params.id, req.params.docId, res, disposition);
}

export async function nextRollNo(req: Request, res: Response): Promise<void> {
  const rollNo = await studentsService.getNextRollNo(req.params.sectionId);
  res.json({ rollNo });
}
