import type { Request, Response } from 'express';
import * as svc from './salaries.service';
import { renderSalarySlipPdf, renderBulkSalarySlipsPdf } from './salaries.pdf';
import { listSalariesQuerySchema } from './salaries.schema';
import { Unauthorized, AppError } from '../../utils/apiResponse';

const actor = (req: Request) => {
  if (!req.user) throw Unauthorized();
  return req.user;
};

export async function generate(req: Request, res: Response) {
  res.json(await svc.generateSalaries(actor(req), req.body));
}
export async function list(req: Request, res: Response) {
  // Parse through the schema so `year`/`month` are coerced to numbers before
  // they reach Prisma (raw req.query values are strings).
  res.json(await svc.listSalaries(listSalariesQuerySchema.parse(req.query)));
}
export async function detail(req: Request, res: Response) {
  await svc.assertCanViewSalarySlip(actor(req), req.params.id);
  res.json(await svc.getSalary(req.params.id));
}
export async function structure(_req: Request, res: Response) {
  res.json(await svc.listSalaryStructure());
}
export async function setStructure(req: Request, res: Response) {
  res.json(await svc.setTeacherSalary(actor(req), req.params.teacherId, req.body.salary));
}
export async function update(req: Request, res: Response) {
  res.json(await svc.updateSalary(actor(req), req.params.id, req.body));
}
export async function setStatus(req: Request, res: Response) {
  res.json(await svc.setSalaryStatus(actor(req), req.params.id, req.body.status, req.body.paidDate));
}
export async function markPaid(req: Request, res: Response) {
  res.json(await svc.markSalariesPaid(actor(req), req.body.slipIds, req.body.paidDate));
}
export async function summary(req: Request, res: Response) {
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = req.query.month === 'all' ? undefined : Number(req.query.month) || now.getMonth() + 1;
  res.json(await svc.salariesSummary(year, month));
}
export async function preflight(req: Request, res: Response) {
  const now = new Date();
  res.json(await svc.salaryGenerationPreflight(Number(req.query.year) || now.getFullYear(), Number(req.query.month) || now.getMonth() + 1));
}
export async function pdf(req: Request, res: Response) {
  await svc.assertCanViewSalarySlip(actor(req), req.params.id);
  const { buffer, filename } = await renderSalarySlipPdf(req.params.id);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${filename}"`);
  res.send(buffer);
}
export async function deleteSalariesForMonth(req: Request, res: Response) {
  const year = Number(req.body?.year || req.query?.year);
  const month = Number(req.body?.month || req.query?.month);
  if (!year || !month) {
    throw new AppError('Year and month are required', 400, 'INVALID_PARAMS');
  }
  res.json(await svc.deleteSalariesForMonth(actor(req), year, month));
}

export async function bulkPdf(req: Request, res: Response) {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new AppError('No slip IDs provided', 400, 'INVALID_PARAMS');
  }

  // Ensure actor can view all slips
  await Promise.all(ids.map(id => svc.assertCanViewSalarySlip(actor(req), id)));

  const { buffer, filename } = await renderBulkSalarySlipsPdf(ids);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${filename}"`);
  res.send(buffer);
}

export async function listMySlips(req: Request, res: Response) {
  res.json(await svc.listMySlips(actor(req).userId));
}

export async function getMySlipDetail(req: Request, res: Response) {
  res.json(await svc.getMySlipDetail(actor(req).userId, req.params.id));
}
