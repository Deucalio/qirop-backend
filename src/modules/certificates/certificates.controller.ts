import type { Request, Response } from 'express';
import { CertificateKind } from '@prisma/client';
import * as svc from './certificates.service';

function actor(req: Request) {
  return { userId: req.user!.userId, role: req.user!.role };
}

export async function listFees(_req: Request, res: Response): Promise<void> {
  res.json(await svc.listCertificateFees());
}

export async function setFee(req: Request, res: Response): Promise<void> {
  const kind = req.params.kind as CertificateKind;
  res.json(await svc.setCertificateFee(actor(req), kind, req.body.amount, req.body.active !== false));
}

export async function recordIssue(req: Request, res: Response): Promise<void> {
  res.status(201).json(await svc.recordCertificateIssue(actor(req), req.body));
}

export async function listIssues(req: Request, res: Response): Promise<void> {
  res.json(
    await svc.listCertificateIssues({
      studentId: (req.query.studentId as string) || undefined,
      kind: (req.query.kind as CertificateKind) || undefined,
      from: (req.query.from as string) || undefined,
      to: (req.query.to as string) || undefined,
    }),
  );
}

export async function summary(req: Request, res: Response): Promise<void> {
  res.json(await svc.certificatesSummary((req.query.from as string) || undefined, (req.query.to as string) || undefined));
}
