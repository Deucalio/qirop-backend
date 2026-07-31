import type { Request, Response } from 'express';
import * as svc from './reports.service';
import { pktDay, pktDayString } from '../../utils/pktDate';
import { prisma } from '../../config/prisma';

function currentYm() {
  const d = pktDay();
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

export async function studentRoster(req: Request, res: Response) {
  res.json(
    await svc.getStudentRosterReport({
      classId: req.query.classId as string | undefined,
      sectionId: req.query.sectionId as string | undefined,
      gender: req.query.gender as string | undefined,
      status: req.query.status as string | undefined,
      search: req.query.search as string | undefined,
    }),
  );
}

export async function feeDefaulters(req: Request, res: Response) {
  res.json(
    await svc.getFeeDefaultersReport({
      classId: req.query.classId as string | undefined,
      sectionId: req.query.sectionId as string | undefined,
      search: req.query.search as string | undefined,
    }),
  );
}

export async function studentAttendanceSummary(req: Request, res: Response) {
  const ym = currentYm();
  const year = Number(req.query.year) || ym.year;
  const month = Number(req.query.month) || ym.month;
  res.json(
    await svc.getStudentAttendanceSummaryReport({
      year,
      month,
      classId: req.query.classId as string | undefined,
      sectionId: req.query.sectionId as string | undefined,
    }),
  );
}

export async function staffAttendanceSummary(req: Request, res: Response) {
  const ym = currentYm();
  const year = Number(req.query.year) || ym.year;
  const month = Number(req.query.month) || ym.month;
  res.json(await svc.getStaffAttendanceSummaryReport({ year, month }));
}

export async function dailyAbsentees(req: Request, res: Response) {
  const dateStr = (req.query.date as string) || pktDayString();
  res.json(await svc.getDailyAbsenteeReport({ date: dateStr }));
}

export async function feeCollectionsAudit(req: Request, res: Response) {
  const ym = currentYm();
  const from = (req.query.from as string) || `${ym.year}-${String(ym.month).padStart(2, '0')}-01`;
  const to = (req.query.to as string) || pktDayString();
  res.json(
    await svc.getFeeCollectionsAuditReport({
      from,
      to,
      method: req.query.method as string | undefined,
    }),
  );
}

export async function expenseLedgerAudit(req: Request, res: Response) {
  const ym = currentYm();
  const from = (req.query.from as string) || `${ym.year}-${String(ym.month).padStart(2, '0')}-01`;
  const to = (req.query.to as string) || pktDayString();
  res.json(
    await svc.getExpenseLedgerAuditReport({
      from,
      to,
      category: req.query.category as string | undefined,
    }),
  );
}

export async function payrollRegister(req: Request, res: Response) {
  const ym = currentYm();
  const year = Number(req.query.year) || ym.year;
  const month = Number(req.query.month) || ym.month;
  res.json(await svc.getPayrollRegisterReport({ year, month }));
}

export async function getSaved(req: Request, res: Response) {
  const reportType = req.query.reportType as string;
  const periodType = req.query.periodType as string;
  const year = Number(req.query.year);
  const month = req.query.month ? Number(req.query.month) : null;
  const classId = (req.query.classId as string) || null;
  const sectionId = (req.query.sectionId as string) || null;

  const report = await svc.findSavedReport({
    reportType,
    periodType,
    year,
    month,
    classId,
    sectionId,
  });

  if (!report) {
    res.status(404).json({ message: 'No saved report found for this period' });
    return;
  }
  res.json(report);
}

export async function createSaved(req: Request, res: Response) {
  const { reportType, periodType, year, month, classId, sectionId } = req.body;
  
  let actorName = 'System Admin';
  if (req.user?.userId) {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (user?.fullName) {
      actorName = user.fullName;
    }
  }

  const report = await svc.createSavedReport(
    {
      reportType,
      periodType,
      year: Number(year),
      month: month ? Number(month) : null,
      classId: classId || null,
      sectionId: sectionId || null,
    },
    actorName,
  );
  res.status(201).json(report);
}

export async function removeSaved(req: Request, res: Response) {
  const { id } = req.params;
  await svc.deleteSavedReport(id);
  res.json({ message: 'Saved report deleted successfully' });
}

export async function listSaved(req: Request, res: Response) {
  res.json(await svc.listSavedReports());
}


