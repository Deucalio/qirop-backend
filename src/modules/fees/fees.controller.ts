import type { Request, Response } from 'express';
import * as svc from './fees.service';
import { renderChallanPdf, renderChallansBatchPdf } from './fees.pdf';
import { Unauthorized, AppError } from '../../utils/apiResponse';

const actor = (req: Request) => {
  if (!req.user) throw Unauthorized();
  return req.user;
};

// Fee structures & discounts
export async function listFeeStructures(_req: Request, res: Response) {
  res.json(await svc.listFeeStructures());
}
export async function setFeeStructure(req: Request, res: Response) {
  res.json(await svc.setFeeStructure(actor(req), req.params.classId, req.body.monthlyFee, req.body.admissionFee));
}
export async function setStudentDiscount(req: Request, res: Response) {
  res.json(await svc.setStudentDiscount(actor(req), req.params.id, req.body.feeDiscount, req.body.discountNote));
}

// Challans
export async function generateChallans(req: Request, res: Response) {
  res.json(await svc.generateChallans(actor(req), req.body));
}
export async function listChallans(req: Request, res: Response) {
  res.json(await svc.listChallans(req.query));
}
export async function generatePreview(req: Request, res: Response) {
  const now = new Date();
  res.json(
    await svc.generatePreview({
      year: Number(req.query.year) || now.getFullYear(),
      month: Number(req.query.month) || now.getMonth() + 1,
      classId: (req.query.classId as string) || undefined,
      sectionId: (req.query.sectionId as string) || undefined,
    }),
  );
}
export async function getChallan(req: Request, res: Response) {
  res.json(await svc.getChallan(req.params.id));
}
export async function patchChallan(req: Request, res: Response) {
  res.json(await svc.patchChallan(actor(req), req.params.id, req.body));
}
export async function deleteChallan(req: Request, res: Response) {
  res.json(await svc.deleteChallan(actor(req), req.params.id));
}
export async function markOverdue(_req: Request, res: Response) {
  res.json(await svc.markOverdue());
}
export async function markPaid(req: Request, res: Response) {
  res.json(await svc.markChallansPaid(actor(req), req.body));
}

// Payments
export async function recordPayment(req: Request, res: Response) {
  res.json(await svc.recordPayment(actor(req), req.body));
}
export async function listPayments(req: Request, res: Response) {
  res.json(await svc.listPayments(req.query));
}
export async function reversePayment(req: Request, res: Response) {
  res.json(await svc.reversePayment(actor(req), req.params.id, req.body.reason));
}
export async function studentLedger(req: Request, res: Response) {
  res.json(await svc.getStudentLedger(req.params.id));
}

// Challan PDF
export async function challanPdf(req: Request, res: Response) {
  const { buffer, challanNo } = await renderChallanPdf(req.params.id);
  const disposition = req.query.download === '1' ? 'attachment' : 'inline';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${disposition}; filename="challan-${challanNo}.pdf"`);
  res.send(buffer);
}
export async function challansPdfBatch(req: Request, res: Response) {
  const ids: unknown = req.body?.ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => typeof x === 'string')) {
    throw new AppError('Provide a non-empty array of challan ids', 400, 'INVALID_IDS');
  }
  if (ids.length > 200) throw new AppError('Cannot print more than 200 challans at once', 400, 'TOO_MANY');
  const buffer = await renderChallansBatchPdf(ids as string[]);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="challans-${ids.length}.pdf"`);
  res.send(buffer);
}

// Parent
export async function childFees(req: Request, res: Response) {
  res.json(await svc.getChildFeesForParent(actor(req).userId, req.params.studentId));
}

// Staff parent (teacher) — decision D4. Never exposes any salary figure.
export async function myStaffChildren(req: Request, res: Response) {
  res.json(await svc.getStaffChildrenForTeacher(actor(req).userId));
}
export async function myStaffChildFees(req: Request, res: Response) {
  res.json(await svc.getStaffChildFeesForTeacher(actor(req).userId, req.params.studentId));
}

/** Challan PDF for a guardian (parent or staff parent) — own children only. */
function guardianChallanPdf(kind: 'parent' | 'teacher') {
  return async (req: Request, res: Response) => {
    const id = await svc.assertGuardianChallan(actor(req).userId, kind, req.params.studentId, req.params.challanId);
    const { buffer, challanNo } = await renderChallanPdf(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="challan-${challanNo}.pdf"`);
    res.send(buffer);
  };
}
export const parentChallanPdf = guardianChallanPdf('parent');
export const teacherChildChallanPdf = guardianChallanPdf('teacher');

// Dashboard
export async function feesSummary(req: Request, res: Response) {
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = Number(req.query.month) || now.getMonth() + 1;
  res.json(await svc.feesSummary(year, month));
}
export async function feesTrend(req: Request, res: Response) {
  const months = Math.min(24, Math.max(1, Number(req.query.months) || 6));
  res.json(await svc.feesTrend(months));
}
