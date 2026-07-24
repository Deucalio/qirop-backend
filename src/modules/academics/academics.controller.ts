import type { Request, Response } from 'express';
import { PermissionModule } from '@prisma/client';
import * as svc from './academics.service';
import { userHasPermission } from '../../utils/permissions';

// ---- Classes ----
export async function listClasses(_req: Request, res: Response): Promise<void> {
  res.json(await svc.listClasses());
}
export async function createClass(req: Request, res: Response): Promise<void> {
  res.status(201).json(
    await svc.createClass(req.body.name, req.body.sections, {
      monthlyFee: req.body.monthlyFee,
      admissionFee: req.body.admissionFee,
    }),
  );
}
export async function updateClass(req: Request, res: Response): Promise<void> {
  res.json(await svc.updateClass(req.params.id, req.body));
}
export async function deleteClass(req: Request, res: Response): Promise<void> {
  await svc.deleteClass(req.params.id);
  res.json({ message: 'Class deleted' });
}

// ---- Sections ----
export async function listSections(req: Request, res: Response): Promise<void> {
  res.json(await svc.listSections(req.params.classId));
}
export async function createSection(req: Request, res: Response): Promise<void> {
  res.status(201).json(await svc.createSection(req.params.classId, req.body.name));
}
export async function updateSection(req: Request, res: Response): Promise<void> {
  res.json(await svc.updateSection(req.params.id, req.body.name));
}
export async function deleteSection(req: Request, res: Response): Promise<void> {
  await svc.deleteSection(req.params.id);
  res.json({ message: 'Section deleted' });
}

// ---- Subjects ----
export async function listSubjects(_req: Request, res: Response): Promise<void> {
  res.json(await svc.listSubjects());
}
export async function createSubject(req: Request, res: Response): Promise<void> {
  res.status(201).json(await svc.createSubject(req.body.name));
}
export async function updateSubject(req: Request, res: Response): Promise<void> {
  res.json(await svc.updateSubject(req.params.id, { name: req.body.name, color: req.body.color }));
}
export async function deleteSubject(req: Request, res: Response): Promise<void> {
  await svc.deleteSubject(req.params.id);
  res.json({ message: 'Subject deleted' });
}
export async function subjectDetails(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  // Teacher names are staff data — include them only when the caller may view STAFF.
  const includeTeachers = await userHasPermission(user.userId, user.role, PermissionModule.STAFF, 'view');
  res.json(await svc.getSubjectDetails(req.params.id, includeTeachers));
}

// ---- Class ↔ Subject mapping ----
export async function getClassSubjects(req: Request, res: Response): Promise<void> {
  res.json(await svc.getClassSubjects(req.params.classId));
}
export async function setClassSubjects(req: Request, res: Response): Promise<void> {
  res.json(await svc.setClassSubjects(req.params.classId, req.body.subjectIds));
}
