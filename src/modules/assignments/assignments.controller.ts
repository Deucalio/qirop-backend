import type { Request, Response } from 'express';
import * as svc from './assignments.service';

export async function setClassTeacher(req: Request, res: Response): Promise<void> {
  res.json(await svc.setClassTeacher(req.params.id, req.body.teacherId));
}

export async function getSectionAssignments(req: Request, res: Response): Promise<void> {
  res.json(await svc.getSectionTeachingAssignments(req.params.sectionId));
}

export async function upsertTeachingAssignment(req: Request, res: Response): Promise<void> {
  const { sectionId, subjectId, teacherId } = req.body;
  res.json(await svc.upsertTeachingAssignment(sectionId, subjectId, teacherId));
}

export async function deleteTeachingAssignment(req: Request, res: Response): Promise<void> {
  const { sectionId, subjectId } = req.body;
  res.json(await svc.deleteTeachingAssignment(sectionId, subjectId));
}
