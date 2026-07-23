import type { Request, Response } from 'express';
import * as teachersService from './teachers.service';
import { attendanceMonthQuerySchema, createTeacherSchema, listTeachersQuerySchema } from './teachers.schema';
import { AppError, Unauthorized } from '../../utils/apiResponse';

export async function list(req: Request, res: Response): Promise<void> {
  const query = listTeachersQuerySchema.parse(req.query);
  res.json(await teachersService.listTeachers(query));
}

export async function detail(req: Request, res: Response): Promise<void> {
  // Reached via STAFF permission → admin-tier only, so salary is included.
  res.json(await teachersService.getTeacher(req.params.id, true));
}

export async function assignments(req: Request, res: Response): Promise<void> {
  res.json(await teachersService.getTeacherAssignments(req.params.id));
}

export async function attendance(req: Request, res: Response): Promise<void> {
  if (!req.user) throw Unauthorized();
  const { year, month } = attendanceMonthQuerySchema.parse(req.query);
  res.json(await teachersService.getTeacherAttendance(req.params.id, req.user, year, month));
}

export async function create(req: Request, res: Response): Promise<void> {
  if (!req.user) throw Unauthorized();

  // When a photo is attached, the body fields arrive as multipart form-data
  // strings. Parse the JSON-encoded fields back into proper types.
  let body = req.body;
  if (req.file) {
    // Multipart: fields are strings; qualifications may be JSON-encoded.
    if (typeof body.qualifications === 'string') {
      try { body.qualifications = JSON.parse(body.qualifications); } catch { /* leave as-is; zod will reject */ }
    }
  }

  const input = createTeacherSchema.parse(body);
  const teacher = await teachersService.createTeacher(req.user.userId, input);

  // Upload the optional photo now that the teacher exists.
  if (req.file) {
    const result = await teachersService.setPhoto(
      teacher.id, req.file.buffer, req.file.originalname, req.file.mimetype,
    );
    res.status(201).json(result);
    return;
  }

  res.status(201).json(teacher);
}

export async function update(req: Request, res: Response): Promise<void> {
  res.json(await teachersService.updateTeacher(req.params.id, req.body));
}

export async function updateStatus(req: Request, res: Response): Promise<void> {
  res.json(await teachersService.setTeacherStatus(req.params.id, req.body.status, req.body.force));
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  await teachersService.resetPassword(req.params.id, req.body.newPassword);
  res.json({ message: 'Password reset successfully' });
}

export async function uploadPhoto(req: Request, res: Response): Promise<void> {
  if (!req.file) throw new AppError('No photo file provided (field name: "photo")', 400, 'NO_FILE');
  res.json(await teachersService.setPhoto(req.params.id, req.file.buffer, req.file.originalname, req.file.mimetype));
}

/** Teacher self-view — salary is never included. */
export async function meTeacher(req: Request, res: Response): Promise<void> {
  if (!req.user) throw Unauthorized();
  res.json(await teachersService.getMeTeacher(req.user.userId));
}

export async function linkStudent(req: Request, res: Response): Promise<void> {
  const { studentId } = req.body as { studentId: string };
  if (!studentId) {
    throw new AppError('studentId is required', 400, 'BAD_REQUEST');
  }
  res.json(await teachersService.linkStudentToTeacher(req.params.id, studentId));
}

export async function purge(req: Request, res: Response): Promise<void> {
  if (!req.user) throw Unauthorized();
  res.json(await teachersService.purgeTeacher(req.user, req.params.id));
}
