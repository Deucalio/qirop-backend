import type { Request, Response } from 'express';
import * as svc from './attendance.service';
import { dateQuerySchema, monthQuerySchema, trendQuerySchema, adminAttendanceQuerySchema } from './attendance.schema';
import { Unauthorized } from '../../utils/apiResponse';
import type { Actor } from './attendance.service';

function actor(req: Request): Actor {
  if (!req.user) throw Unauthorized();
  return { userId: req.user.userId, role: req.user.role };
}

// ---- teacher self ----
export async function checkIn(req: Request, res: Response): Promise<void> {
  res.json(await svc.checkIn(actor(req).userId));
}
export async function myTeacherAttendance(req: Request, res: Response): Promise<void> {
  const { year, month } = monthQuerySchema.parse(req.query);
  res.json(await svc.getMyTeacherAttendance(actor(req).userId, year, month));
}

// ---- admin: teacher attendance ----
export async function setTeacherAttendance(req: Request, res: Response): Promise<void> {
  const { date, status, checkInTime } = req.body;
  res.json(await svc.setTeacherAttendance(req.params.id, date, status, checkInTime));
}
export async function listTeacherAttendance(req: Request, res: Response): Promise<void> {
  const { date } = dateQuerySchema.parse(req.query);
  res.json(await svc.listTeacherAttendance(date));
}

// ---- student attendance (section) ----
export async function sectionRoster(req: Request, res: Response): Promise<void> {
  const { date } = dateQuerySchema.parse(req.query);
  res.json(await svc.getSectionRoster(actor(req), req.params.sectionId, date));
}
export async function markSection(req: Request, res: Response): Promise<void> {
  const { date, records } = req.body;
  res.json(await svc.markSection(actor(req), req.params.sectionId, date, records));
}

// ---- admin views + dashboard ----
export async function byDate(req: Request, res: Response): Promise<void> {
  const { date, classId, sectionId } = adminAttendanceQuerySchema.parse(req.query);
  res.json(await svc.getAttendanceByDate(date, classId, sectionId));
}
export async function summary(req: Request, res: Response): Promise<void> {
  const { date } = dateQuerySchema.parse(req.query);
  res.json(await svc.getSummary(date));
}
export async function trend(req: Request, res: Response): Promise<void> {
  const { days } = trendQuerySchema.parse(req.query);
  res.json(await svc.getTrend(days));
}

// ---- parent ----
export async function myChildren(req: Request, res: Response): Promise<void> {
  res.json(await svc.getMyChildren(actor(req).userId));
}
export async function childAttendance(req: Request, res: Response): Promise<void> {
  const { year, month } = monthQuerySchema.parse(req.query);
  res.json(await svc.getChildAttendance(actor(req).userId, req.params.studentId, year, month));
}
