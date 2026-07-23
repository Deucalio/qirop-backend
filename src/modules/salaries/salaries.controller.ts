import type { Request, Response } from 'express';
import * as svc from './salaries.service';
import { renderSalarySlipPdf } from './salaries.pdf';
import { Unauthorized } from '../../utils/apiResponse';

const actor = (req: Request) => {
  if (!req.user) throw Unauthorized();
  return req.user;
};

export async function generate(req: Request, res: Response) {
  res.json(await svc.generateSalaries(actor(req), req.body));
}
export async function list(req: Request, res: Response) {
  res.json(await svc.listSalaries(req.query as never));
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
