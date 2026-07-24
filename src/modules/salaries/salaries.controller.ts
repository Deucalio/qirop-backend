import type { Request, Response } from 'express';
import * as svc from './salaries.service';
import { renderSalarySlipPdf } from './salaries.pdf';
import { listSalariesQuerySchema } from './salaries.schema';
import { Unauthorized } from '../../utils/apiResponse';

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
  res.json(await svc.getSalary(req.params.id));
}
export async function update(req: Request, res: Response) {
  res.json(await svc.updateSalary(actor(req), req.params.id, req.body));
}
export async function setStatus(req: Request, res: Response) {
  res.json(await svc.setSalaryStatus(actor(req), req.params.id, req.body.status, req.body.paidDate));
}
export async function summary(req: Request, res: Response) {
  const now = new Date();
  res.json(await svc.salariesSummary(Number(req.query.year) || now.getFullYear(), Number(req.query.month) || now.getMonth() + 1));
}
export async function pdf(req: Request, res: Response) {
  const { buffer, filename } = await renderSalarySlipPdf(req.params.id);
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
