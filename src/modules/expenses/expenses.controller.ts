import type { Request, Response } from 'express';
import * as svc from './expenses.service';
import { listExpensesQuerySchema } from './expenses.schema';
import { AppError, Unauthorized } from '../../utils/apiResponse';

const actor = (req: Request) => {
  if (!req.user) throw Unauthorized();
  return req.user;
};

export async function list(req: Request, res: Response) {
  res.json(await svc.listExpenses(listExpensesQuerySchema.parse(req.query)));
}
export async function detail(req: Request, res: Response) {
  res.json(await svc.getExpense(req.params.id));
}
export async function create(req: Request, res: Response) {
  res.status(201).json(await svc.createExpense(actor(req), req.body));
}
export async function update(req: Request, res: Response) {
  res.json(await svc.updateExpense(actor(req), req.params.id, req.body));
}
export async function remove(req: Request, res: Response) {
  res.json(await svc.deleteExpense(actor(req), req.params.id));
}
export async function uploadReceipt(req: Request, res: Response) {
  if (!req.file) throw new AppError('No receipt file provided (field name: "receipt")', 400, 'NO_FILE');
  res.json(await svc.setReceipt(actor(req), req.params.id, req.file.buffer, req.file.originalname, req.file.mimetype));
}
export async function downloadReceipt(req: Request, res: Response) {
  await svc.streamReceipt(req.params.id, res);
}
export async function addAttachment(req: Request, res: Response) {
  const files: Express.Multer.File[] = [];
  if (req.files && Array.isArray(req.files)) {
    files.push(...req.files);
  } else if (req.files && typeof req.files === 'object') {
    for (const key of Object.keys(req.files)) {
      const fieldFiles = (req.files as Record<string, Express.Multer.File[]>)[key];
      if (Array.isArray(fieldFiles)) files.push(...fieldFiles);
    }
  }
  if (req.file) {
    files.push(req.file);
  }

  if (files.length === 0) {
    throw new AppError('No file provided for attachment upload', 400, 'NO_FILE');
  }

  const mapped = files.map((f) => ({
    buffer: f.buffer,
    originalName: f.originalname,
    mimeType: f.mimetype,
  }));

  res.json(await svc.addExpenseAttachmentsBatch(actor(req), req.params.id, mapped));
}
export async function deleteAttachment(req: Request, res: Response) {
  res.json(await svc.removeExpenseAttachment(actor(req), req.params.attachmentId));
}
export async function downloadAttachment(req: Request, res: Response) {
  await svc.downloadExpenseAttachment(req.params.attachmentId, res);
}

function monthRange(year: number, month: number): { from: string; to: string } {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, '0')}` };
}

export async function summary(req: Request, res: Response) {
  const now = new Date();
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  if (from && to) {
    res.json(await svc.expensesSummary(from, to));
    return;
  }
  const range = monthRange(Number(req.query.year) || now.getFullYear(), Number(req.query.month) || now.getMonth() + 1);
  res.json(await svc.expensesSummary(range.from, range.to));
}

export async function finance(req: Request, res: Response) {
  const now = new Date();
  res.json(await svc.financeSummary(Number(req.query.year) || now.getFullYear()));
}
