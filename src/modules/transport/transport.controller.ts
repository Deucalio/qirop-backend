import type { Request, Response } from 'express';
import * as svc from './transport.service';
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
