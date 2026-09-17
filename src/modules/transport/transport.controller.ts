import type { Request, Response } from 'express';
import * as svc from './transport.service';
import * as billing from './transport.billing.service';
import { renderTransportChallanPdf, renderTransportChallansBatchPdf, renderTransportReceiptPdf } from './transport.pdf';
import {
  listTransportChallansQuerySchema,
  listTransportPaymentsQuerySchema,
  transportPreviewQuerySchema,
} from './transport.schema';
import { Unauthorized } from '../../utils/apiResponse';

const actor = (req: Request) => {
  if (!req.user) throw Unauthorized();
  return req.user;
};

export async function listRoutes(_req: Request, res: Response) {
  res.json(await svc.listRoutes());
}
export async function getRoute(req: Request, res: Response) {
  res.json(await svc.getRoute(req.params.id));
}
export async function createRoute(req: Request, res: Response) {
  res.status(201).json(await svc.createRoute(actor(req), req.body));
}
export async function updateRoute(req: Request, res: Response) {
  res.json(await svc.updateRoute(actor(req), req.params.id, req.body));
}
export async function deleteRoute(req: Request, res: Response) {
  res.json(await svc.deleteRoute(actor(req), req.params.id));
}
export async function assign(req: Request, res: Response) {
  res.json(await svc.assign(actor(req), req.body));
}
export async function unassign(req: Request, res: Response) {
  res.json(await svc.unassign(actor(req), req.body));
}
export async function summary(_req: Request, res: Response) {
  res.json(await svc.transportSummary());
}

// ---- Transport challans ----
export async function challanPreview(req: Request, res: Response) {
  res.json(await billing.previewTransportChallans(transportPreviewQuerySchema.parse(req.query)));
}
export async function generateChallans(req: Request, res: Response) {
  res.json(await billing.generateTransportChallans(actor(req), req.body));
}
export async function listChallans(req: Request, res: Response) {
  res.json(await billing.listTransportChallans(listTransportChallansQuerySchema.parse(req.query)));
}
export async function getChallan(req: Request, res: Response) {
  res.json(await billing.getTransportChallan(req.params.id));
}
export async function patchChallan(req: Request, res: Response) {
  res.json(await billing.patchTransportChallan(actor(req), req.params.id, req.body));
}
export async function deleteChallan(req: Request, res: Response) {
  res.json(await billing.deleteTransportChallan(actor(req), req.params.id));
}

function sendPdf(req: Request, res: Response, buffer: Buffer, filename: string, defaultDisposition: 'inline' | 'attachment' = 'inline') {
  const disposition = req.query.download === '1' ? 'attachment' : defaultDisposition;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
  res.send(buffer);
}

export async function challanPdf(req: Request, res: Response) {
  const { buffer, challanNo } = await renderTransportChallanPdf(req.params.id);
  sendPdf(req, res, buffer, `transport-${challanNo}.pdf`);
}
export async function printChallans(req: Request, res: Response) {
  const ids: string[] = req.body.ids;
  sendPdf(req, res, await renderTransportChallansBatchPdf(ids), `transport-challans-${ids.length}.pdf`, 'attachment');
}

// ---- Transport payments ----
export async function recordPayment(req: Request, res: Response) {
  res.status(201).json(await billing.recordTransportPayment(actor(req), req.body));
}
export async function listPayments(req: Request, res: Response) {
  res.json(await billing.listTransportPayments(listTransportPaymentsQuerySchema.parse(req.query)));
}
export async function markChallansPaid(req: Request, res: Response) {
  res.json(await billing.markTransportChallansPaid(actor(req), req.body));
}
export async function reversePayment(req: Request, res: Response) {
  res.json(await billing.reverseTransportPayment(actor(req), req.params.id, req.body.reason));
}
export async function paymentReceiptPdf(req: Request, res: Response) {
  const { buffer, receiptNo } = await renderTransportReceiptPdf(req.params.id);
  sendPdf(req, res, buffer, `transport-receipt-${receiptNo}.pdf`);
}

// ---- One rider (profile modals) ----
export async function studentRiderTransport(req: Request, res: Response) {
  res.json(await billing.getStudentRiderTransport(req.params.id));
}
export async function staffRiderTransport(req: Request, res: Response) {
  res.json(await billing.getStaffRiderTransport(req.params.id));
}

// ---- Guardians: a parent's own children, a staff member's own fares ----
export async function childTransport(req: Request, res: Response) {
  res.json(await billing.getChildTransportForParent(actor(req).userId, req.params.studentId));
}
export async function childTransportChallanPdf(req: Request, res: Response) {
  const id = await billing.assertOwnTransportChallan(
    actor(req).userId,
    { kind: 'parent', studentId: req.params.studentId },
    req.params.challanId,
  );
  const { buffer, challanNo } = await renderTransportChallanPdf(id);
  sendPdf(req, res, buffer, `transport-${challanNo}.pdf`);
}
export async function myTransport(req: Request, res: Response) {
  res.json(await billing.getMyStaffTransport(actor(req).userId));
}
export async function myTransportChallanPdf(req: Request, res: Response) {
  const id = await billing.assertOwnTransportChallan(actor(req).userId, { kind: 'staff' }, req.params.challanId);
  const { buffer, challanNo } = await renderTransportChallanPdf(id);
  sendPdf(req, res, buffer, `transport-${challanNo}.pdf`);
}
