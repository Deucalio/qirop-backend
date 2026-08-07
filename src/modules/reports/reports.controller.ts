import type { Request, Response } from 'express';
import * as svc from './reports.service';
import { pktDay, pktDayString } from '../../utils/pktDate';
import { prisma } from '../../config/prisma';
import { logAudit } from '../audit/audit.service';

/**
 * Month from the query string, where an explicit `month=0` means "whole year".
 * `Number(x) || fallback` cannot express that — 0 is falsy, so a yearly request
 * silently collapsed to the current month.
 */
function monthParam(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 12 ? n : fallback;
}


function currentYm() {
  const d = pktDay();
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

export async function studentRoster(req: Request, res: Response) {
  const data = await svc.getStudentRosterReport({
    classId: req.query.classId as string | undefined,
    sectionId: req.query.sectionId as string | undefined,
    gender: req.query.gender as string | undefined,
    status: req.query.status as string | undefined,
    search: req.query.search as string | undefined,
    // Optional: absent means "everyone today"; month=0 means the whole year.
    ...(req.query.year ? { year: Number(req.query.year), month: monthParam(req.query.month, 0) } : {}),
  });

  void logAudit(req, {
    action: 'GENERATE',
    module: 'REPORTS',
    targetType: 'Report',
    targetLabel: 'Student Roster & Directory',
    details: 'Generated live Student Roster & Parent Directory report',
  });

  res.json(data);
}

export async function feeDefaulters(req: Request, res: Response) {
  const data = await svc.getFeeDefaultersReport({
    classId: req.query.classId as string | undefined,
    sectionId: req.query.sectionId as string | undefined,
    search: req.query.search as string | undefined,
    // Optional: absent means "everything owed today"; month=0 means the whole year.
    ...(req.query.year ? { year: Number(req.query.year), month: monthParam(req.query.month, 0) } : {}),
  });

  void logAudit(req, {
    action: 'GENERATE',
    module: 'REPORTS',
    targetType: 'Report',
    targetLabel: 'Fee Defaulters Audit',
    details: 'Generated live Fee Defaulters & Outstanding Dues report',
  });

  res.json(data);
}

export async function studentAttendanceSummary(req: Request, res: Response) {
  const ym = currentYm();
  const year = Number(req.query.year) || ym.year;
  const month = monthParam(req.query.month, ym.month);

  const data = await svc.getStudentAttendanceSummaryReport({
    year,
    month,
    classId: req.query.classId as string | undefined,
    sectionId: req.query.sectionId as string | undefined,
  });

  void logAudit(req, {
    action: 'GENERATE',
    module: 'REPORTS',
    targetType: 'Report',
    targetLabel: 'Student Attendance Summary',
    details: `Generated live Student Attendance Summary report for ${month}/${year}`,
  });

  res.json(data);
}

export async function staffAttendanceSummary(req: Request, res: Response) {
  const ym = currentYm();
  const year = Number(req.query.year) || ym.year;
  const month = monthParam(req.query.month, ym.month);

  const data = await svc.getStaffAttendanceSummaryReport({ year, month });

  void logAudit(req, {
    action: 'GENERATE',
    module: 'REPORTS',
    targetType: 'Report',
    targetLabel: 'Staff Attendance Summary',
    details: `Generated live Staff Attendance Summary report for ${month}/${year}`,
  });

  res.json(data);
}

export async function dailyAbsentees(req: Request, res: Response) {
  const dateStr = (req.query.date as string) || pktDayString();
  const data = await svc.getDailyAbsenteeReport({ date: dateStr });

  void logAudit(req, {
    action: 'GENERATE',
    module: 'REPORTS',
    targetType: 'Report',
    targetLabel: 'Daily Absentee Report',
    details: `Generated live Daily Absentee report for ${dateStr}`,
  });

  res.json(data);
}

export async function feeCollectionsAudit(req: Request, res: Response) {
  const ym = currentYm();
  const from = (req.query.from as string) || `${ym.year}-${String(ym.month).padStart(2, '0')}-01`;
  const to = (req.query.to as string) || pktDayString();

  const data = await svc.getFeeCollectionsAuditReport({
    from,
    to,
    method: req.query.method as string | undefined,
  });

  void logAudit(req, {
    action: 'GENERATE',
    module: 'REPORTS',
    targetType: 'Report',
    targetLabel: 'Fee Collections Audit',
    details: `Generated live Fee Collections Audit report from ${from} to ${to}`,
  });

  res.json(data);
}

export async function expenseLedgerAudit(req: Request, res: Response) {
  const ym = currentYm();
  const from = (req.query.from as string) || `${ym.year}-${String(ym.month).padStart(2, '0')}-01`;
  const to = (req.query.to as string) || pktDayString();

  const data = await svc.getExpenseLedgerAuditReport({
    from,
    to,
    category: req.query.category as string | undefined,
  });

  void logAudit(req, {
    action: 'GENERATE',
    module: 'REPORTS',
    targetType: 'Report',
    targetLabel: 'Expense Ledger Audit',
    details: `Generated live Expense Ledger Audit report from ${from} to ${to}`,
  });

  res.json(data);
}

export async function payrollRegister(req: Request, res: Response) {
  const ym = currentYm();
  const year = Number(req.query.year) || ym.year;
  const month = monthParam(req.query.month, ym.month);

  const data = await svc.getPayrollRegisterReport({ year, month });

  void logAudit(req, {
    action: 'GENERATE',
    module: 'REPORTS',
    targetType: 'Report',
    targetLabel: 'Payroll Register',
    details: `Generated live Payroll Register report for ${month}/${year}`,
  });

  res.json(data);
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

  void logAudit(req, {
    action: 'CREATE',
    module: 'REPORTS',
    targetType: 'SavedReport',
    targetId: report.id,
    targetLabel: report.title,
    details: `Compiled & archived snapshot: "${report.title}"`,
    changes: {
      reportType: report.reportType,
      periodType: report.periodType,
      year: report.year,
      month: report.month,
      generatedBy: report.generatedBy,
    },
  });

  res.status(201).json(report);
}

export async function removeSaved(req: Request, res: Response) {
  const { id } = req.params;
  const existing = await prisma.savedReport.findUnique({ where: { id } });

  await svc.deleteSavedReport(id);

  void logAudit(req, {
    action: 'DELETE',
    module: 'REPORTS',
    targetType: 'SavedReport',
    targetId: id,
    targetLabel: existing?.title ?? 'Saved Report Snapshot',
    details: `Deleted archived report snapshot: "${existing?.title ?? id}"`,
  });

  res.json({ message: 'Saved report deleted successfully' });
}

export async function listSaved(req: Request, res: Response) {
  res.json(await svc.listSavedReports());
}
