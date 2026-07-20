import type { Request, Response } from 'express';
import type { DayOfWeek } from '@prisma/client';
import * as svc from './timetable.service';
import { Unauthorized } from '../../utils/apiResponse';

export async function sectionTimetable(req: Request, res: Response): Promise<void> {
  res.json(await svc.getSectionTimetable(req.params.sectionId));
}

export async function slotOptions(req: Request, res: Response): Promise<void> {
  const day = req.query.day as DayOfWeek;
  const periodIndex = Number(req.query.periodIndex);
  res.json(await svc.getSlotOptions(req.params.sectionId, day, periodIndex));
}

export async function setSlot(req: Request, res: Response): Promise<void> {
  const { day, periodIndex, subjectId, withSectionIds, force } = req.body;
  res.json(await svc.setSlot(req.params.sectionId, day, periodIndex, subjectId, { withSectionIds, force }));
}

export async function timetableConfig(_req: Request, res: Response): Promise<void> {
  res.json(await svc.getTimetableLayout());
}

export async function saveTimetableConfig(req: Request, res: Response): Promise<void> {
  const { config, dryRun } = req.body;
  res.json(await svc.saveTimetableConfig(config, dryRun === true));
}

export async function setValidity(req: Request, res: Response): Promise<void> {
  const { from, until } = req.body;
  res.json(await svc.setTimetableValidity(req.params.sectionId, from, until));
}

export async function meTeacherTimetable(req: Request, res: Response): Promise<void> {
  if (!req.user) throw Unauthorized();
  res.json(await svc.getTeacherTimetable(req.user.userId));
}

export async function childTimetable(req: Request, res: Response): Promise<void> {
  if (!req.user) throw Unauthorized();
  res.json(await svc.getChildTimetable(req.user.userId, req.params.studentId));
}

export async function sectionPeriodAttendance(req: Request, res: Response): Promise<void> {
  res.json(await svc.getSectionPeriodAttendance(req.params.sectionId, req.query.date as string | undefined));
}

export async function markPeriodAttendance(req: Request, res: Response): Promise<void> {
  if (!req.user) throw Unauthorized();
  const { date, records } = req.body;
  res.json(await svc.markSectionPeriodAttendance(req.user, req.params.sectionId, date, records));
}
