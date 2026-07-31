import { prisma } from '../../config/prisma';
import { parsePktDay, pktDayString } from '../../utils/pktDate';
import { toMoneyString, ZERO, sum, round2, money } from '../../utils/money';
import { AppError } from '../../utils/apiResponse';
import type { Prisma, ExpenseCategory, PayerType, PaymentMethod, Gender, UserStatus, AttendanceStatus } from '@prisma/client';

export interface RosterQuery {
  classId?: string;
  sectionId?: string;
  gender?: string;
  status?: string;
  search?: string;
}

export async function getStudentRosterReport(query: RosterQuery) {
  const where: Prisma.StudentWhereInput = {
    ...(query.classId && query.classId !== 'all' ? { section: { classId: query.classId } } : {}),
    ...(query.sectionId && query.sectionId !== 'all' ? { sectionId: query.sectionId } : {}),
    ...(query.gender && query.gender !== 'all' ? { gender: query.gender as Gender } : {}),
    ...(query.status && query.status !== 'all' ? { status: query.status as UserStatus } : {}),
    ...(query.search
      ? {
          OR: [
            { firstName: { contains: query.search, mode: 'insensitive' } },
            { lastName: { contains: query.search, mode: 'insensitive' } },
            { admissionNo: { contains: query.search, mode: 'insensitive' } },
            { parent: { user: { fullName: { contains: query.search, mode: 'insensitive' } } } },
          ],
        }
      : {}),
  };

  const students = await prisma.student.findMany({
    where,
    include: {
      section: { include: { class: true } },
      parent: { include: { user: { select: { fullName: true, phone: true, cnic: true } } } },
      transportAssignment: { include: { route: true } },
    },
    orderBy: [{ section: { class: { order: 'asc' } } }, { section: { name: 'asc' } }, { firstName: 'asc' }],
  });

  const total = students.length;
  const active = students.filter((s) => s.status === 'ACTIVE').length;
  const male = students.filter((s) => s.gender === 'MALE').length;
  const female = students.filter((s) => s.gender === 'FEMALE').length;
  const withTransport = students.filter((s) => !!s.transportAssignment).length;

  return {
    summary: { total, active, inactive: total - active, male, female, withTransport },
    students: students.map((s) => ({
      id: s.id,
      admissionNo: s.admissionNo,
      rollNo: s.rollNo ?? '—',
      name: `${s.firstName} ${s.lastName}`,
      gender: s.gender,
      admissionDate: pktDayString(s.admissionDate),
      status: s.status,
      className: s.section.class.name,
      sectionName: s.section.name,
      parentName: s.parent.user.fullName,
      parentCnic: s.parent.user.cnic,
      parentPhone: s.parent.user.phone ?? '—',
      motherName: s.parent.motherName ?? '—',
      transportRoute: s.transportAssignment?.route.name ?? 'None',
      photoUrl: s.photoUrl,
    })),
  };
}

export interface DefaultersQuery {
  classId?: string;
  sectionId?: string;
  search?: string;
}

export async function getFeeDefaultersReport(query: DefaultersQuery) {
  const whereStudent: Prisma.StudentWhereInput = {
    status: 'ACTIVE',
    ...(query.classId && query.classId !== 'all' ? { section: { classId: query.classId } } : {}),
    ...(query.sectionId && query.sectionId !== 'all' ? { sectionId: query.sectionId } : {}),
    ...(query.search
      ? {
          OR: [
            { firstName: { contains: query.search, mode: 'insensitive' } },
            { lastName: { contains: query.search, mode: 'insensitive' } },
            { admissionNo: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const students = await prisma.student.findMany({
    where: whereStudent,
    include: {
      section: { include: { class: true } },
      parent: { include: { user: { select: { fullName: true, phone: true } } } },
      challans: {
        where: { status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] } },
        include: { allocations: true },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
      },
      payments: {
        where: { isReversed: false },
        orderBy: { paymentDate: 'desc' },
        take: 1,
      },
    },
  });

  const defaulters = students
    .map((s) => {
      let totalUnpaid = ZERO;
      let unpaidChallanCount = 0;
      const unpaidMonths: string[] = [];

      for (const c of s.challans) {
        const paid = sum(c.allocations.map((a) => a.amountApplied));
        const rem = c.amount.minus(paid);
        if (rem.greaterThan(0)) {
          totalUnpaid = totalUnpaid.plus(rem);
          unpaidChallanCount += 1;
          unpaidMonths.push(`${c.month}/${c.year}`);
        }
      }

      if (totalUnpaid.equals(0)) return null;

      return {
        id: s.id,
        admissionNo: s.admissionNo,
        name: `${s.firstName} ${s.lastName}`,
        className: s.section.class.name,
        sectionName: s.section.name,
        parentName: s.parent.user.fullName,
        parentPhone: s.parent.user.phone ?? '—',
        unpaidChallanCount,
        unpaidMonths,
        totalOutstanding: toMoneyString(totalUnpaid),
        lastPaymentDate: s.payments[0] ? pktDayString(s.payments[0].paymentDate) : 'No payments',
        photoUrl: s.photoUrl,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => Number(b.totalOutstanding) - Number(a.totalOutstanding));

  const totalOutstandingAmount = sum(defaulters.map((d) => d.totalOutstanding));
  const totalDefaulters = defaulters.length;
  const avgDues = totalDefaulters > 0 ? round2(totalOutstandingAmount.dividedBy(totalDefaulters)) : ZERO;

  return {
    summary: {
      totalDefaulters,
      totalOutstandingAmount: toMoneyString(totalOutstandingAmount),
      averageDuesPerDefaulter: toMoneyString(avgDues),
    },
    defaulters,
  };
}

export interface StudentAttendanceSummaryQuery {
  year: number;
  month: number;
  classId?: string;
  sectionId?: string;
}

export async function getStudentAttendanceSummaryReport(query: StudentAttendanceSummaryQuery) {
  const start = new Date(Date.UTC(query.year, query.month - 1, 1));
  const end = new Date(Date.UTC(query.year, query.month, 0, 23, 59, 59));

  const whereStudent: Prisma.StudentWhereInput = {
    status: 'ACTIVE',
    ...(query.classId && query.classId !== 'all' ? { section: { classId: query.classId } } : {}),
    ...(query.sectionId && query.sectionId !== 'all' ? { sectionId: query.sectionId } : {}),
  };

  const [students, attendanceRecords] = await Promise.all([
    prisma.student.findMany({
      where: whereStudent,
      include: {
        section: { include: { class: true } },
      },
      orderBy: [{ section: { class: { order: 'asc' } } }, { firstName: 'asc' }],
    }),
    prisma.studentAttendance.findMany({
      where: {
        date: { gte: start, lte: end },
        ...(query.classId && query.classId !== 'all' ? { section: { classId: query.classId } } : {}),
        ...(query.sectionId && query.sectionId !== 'all' ? { sectionId: query.sectionId } : {}),
      },
      select: { studentId: true, status: true, date: true },
    }),
  ]);

  const distinctDays = new Set(attendanceRecords.map((r) => r.date.toISOString().slice(0, 10))).size;
  const attMap = new Map<string, { present: number; absent: number; leave: number; late: number }>();

  for (const r of attendanceRecords) {
    const cur = attMap.get(r.studentId) ?? { present: 0, absent: 0, leave: 0, late: 0 };
    if (r.status === 'PRESENT') cur.present += 1;
    else if (r.status === 'ABSENT') cur.absent += 1;
    else if (r.status === 'LEAVE') cur.leave += 1;
    else if (r.status === 'LATE') cur.late += 1;
    attMap.set(r.studentId, cur);
  }

  const rows = students.map((s) => {
    const counts = attMap.get(s.id) ?? { present: 0, absent: 0, leave: 0, late: 0 };
    const totalMarked = counts.present + counts.absent + counts.leave + counts.late;
    const effectivePresent = counts.present + counts.late;
    const attendancePct = totalMarked > 0 ? Math.round((effectivePresent / totalMarked) * 100) : 100;

    return {
      id: s.id,
      admissionNo: s.admissionNo,
      rollNo: s.rollNo ?? '—',
      name: `${s.firstName} ${s.lastName}`,
      className: s.section.class.name,
      sectionName: s.section.name,
      totalMarkedDays: totalMarked,
      present: counts.present,
      absent: counts.absent,
      leave: counts.leave,
      late: counts.late,
      attendancePct,
      photoUrl: s.photoUrl,
    };
  });

  const totalRecords = rows.reduce((s, r) => s + r.totalMarkedDays, 0);
  const totalPresent = rows.reduce((s, r) => s + r.present + r.late, 0);
  const overallClassPct = totalRecords > 0 ? Math.round((totalPresent / totalRecords) * 100) : 100;

  return {
    summary: {
      year: query.year,
      month: query.month,
      totalWorkingDays: distinctDays,
      totalStudents: students.length,
      overallAttendancePct: overallClassPct,
    },
    rows,
  };
}

export async function getStaffAttendanceSummaryReport(query: { year: number; month: number }) {
  const start = new Date(Date.UTC(query.year, query.month - 1, 1));
  const end = new Date(Date.UTC(query.year, query.month, 0, 23, 59, 59));

  const [teachers, attendanceRecords] = await Promise.all([
    prisma.teacherProfile.findMany({
      where: { status: 'ACTIVE' },
      include: { user: { select: { fullName: true, phone: true, avatarUrl: true } } },
      orderBy: { user: { fullName: 'asc' } },
    }),
    prisma.teacherAttendance.findMany({
      where: { date: { gte: start, lte: end } },
      select: { teacherId: true, status: true, date: true, checkInTime: true },
    }),
  ]);

  const distinctDays = new Set(attendanceRecords.map((r) => r.date.toISOString().slice(0, 10))).size;
  const attMap = new Map<string, { present: number; absent: number; leave: number; late: number }>();

  for (const r of attendanceRecords) {
    const cur = attMap.get(r.teacherId) ?? { present: 0, absent: 0, leave: 0, late: 0 };
    if (r.status === 'PRESENT') cur.present += 1;
    else if (r.status === 'ABSENT') cur.absent += 1;
    else if (r.status === 'LEAVE') cur.leave += 1;
    else if (r.status === 'LATE') cur.late += 1;
    attMap.set(r.teacherId, cur);
  }

  const rows = teachers.map((t) => {
    const counts = attMap.get(t.id) ?? { present: 0, absent: 0, leave: 0, late: 0 };
    const totalMarked = counts.present + counts.absent + counts.leave + counts.late;
    const effectivePresent = counts.present + counts.late;
    const attendancePct = totalMarked > 0 ? Math.round((effectivePresent / totalMarked) * 100) : 100;

    return {
      id: t.id,
      employeeId: t.employeeId,
      name: t.user.fullName,
      phone: t.user.phone ?? '—',
      totalMarkedDays: totalMarked,
      present: counts.present,
      absent: counts.absent,
      leave: counts.leave,
      late: counts.late,
      attendancePct,
      avatarUrl: t.user.avatarUrl,
    };
  });

  const totalRecords = rows.reduce((s, r) => s + r.totalMarkedDays, 0);
  const totalPresent = rows.reduce((s, r) => s + r.present + r.late, 0);
  const overallStaffPct = totalRecords > 0 ? Math.round((totalPresent / totalRecords) * 100) : 100;

  return {
    summary: {
      year: query.year,
      month: query.month,
      totalWorkingDays: distinctDays,
      totalStaff: teachers.length,
      overallStaffPct,
    },
    rows,
  };
}

export async function getDailyAbsenteeReport(query: { date: string }) {
  const targetDate = parsePktDay(query.date);

  const [studentAbsentees, teacherAbsentees] = await Promise.all([
    prisma.studentAttendance.findMany({
      where: { date: targetDate, status: { in: ['ABSENT', 'LEAVE'] } },
      include: {
        student: {
          include: {
            section: { include: { class: true } },
            parent: { include: { user: { select: { fullName: true, phone: true } } } },
          },
        },
      },
    }),
    prisma.teacherAttendance.findMany({
      where: { date: targetDate, status: { in: ['ABSENT', 'LEAVE'] } },
      include: {
        teacher: { include: { user: { select: { fullName: true, phone: true, avatarUrl: true } } } },
      },
    }),
  ]);

  const students = studentAbsentees.map((a) => ({
    id: a.student.id,
    type: 'STUDENT' as const,
    code: a.student.admissionNo,
    name: `${a.student.firstName} ${a.student.lastName}`,
    className: a.student.section.class.name,
    sectionName: a.student.section.name,
    status: a.status,
    contactPerson: a.student.parent.user.fullName,
    contactPhone: a.student.parent.user.phone ?? '—',
    note: a.note ?? 'No note',
    photoUrl: a.student.photoUrl,
  }));

  const staff = teacherAbsentees.map((a) => ({
    id: a.teacher.id,
    type: 'STAFF' as const,
    code: a.teacher.employeeId,
    name: a.teacher.user.fullName,
    className: 'Staff',
    sectionName: '—',
    status: a.status,
    contactPerson: a.teacher.user.fullName,
    contactPhone: a.teacher.user.phone ?? '—',
    note: 'Staff absence',
    avatarUrl: a.teacher.user.avatarUrl,
  }));

  return {
    date: query.date,
    totalAbsentees: students.length + staff.length,
    studentsCount: students.length,
    staffCount: staff.length,
    list: [...students, ...staff],
  };
}

export async function getFeeCollectionsAuditReport(query: { from: string; to: string; method?: string }) {
  const fromDate = parsePktDay(query.from);
  const toDate = parsePktDay(query.to);

  const payments = await prisma.feePayment.findMany({
    where: {
      paymentDate: { gte: fromDate, lte: toDate },
      isReversed: false,
      ...(query.method && query.method !== 'all' ? { method: query.method as PaymentMethod } : {}),
    },
    include: {
      student: { include: { section: { include: { class: true } } } },
      receivedBy: { select: { fullName: true } },
      allocations: { include: { challan: { include: { items: true } } } },
    },
    orderBy: { paymentDate: 'desc' },
  });

  let tuitionTotal = ZERO;
  let transportTotal = ZERO;
  let admissionTotal = ZERO;
  let lateFeeTotal = ZERO;
  let cashTotal = ZERO;
  let bankTotal = ZERO;

  const rows = payments.map((p) => {
    if (p.method === 'CASH') cashTotal = cashTotal.plus(p.amount);
    else bankTotal = bankTotal.plus(p.amount);

    for (const alloc of p.allocations) {
      const c = alloc.challan;
      if (!c || !c.amount || Number(c.amount) <= 0) continue;
      const ratio = money(alloc.amountApplied).dividedBy(money(c.amount));

      for (const item of c.items) {
        const itemShare = round2(money(item.amount).times(ratio));
        if (item.type === 'TUITION') tuitionTotal = tuitionTotal.plus(itemShare);
        else if (item.type === 'TRANSPORT') transportTotal = transportTotal.plus(itemShare);
        else if (item.type === 'ADMISSION') admissionTotal = admissionTotal.plus(itemShare);
        else lateFeeTotal = lateFeeTotal.plus(itemShare);
      }
    }

    return {
      id: p.id,
      date: pktDayString(p.paymentDate),
      studentName: `${p.student.firstName} ${p.student.lastName}`,
      admissionNo: p.student.admissionNo,
      className: p.student.section.class.name,
      amount: toMoneyString(p.amount),
      method: p.method,
      receivedBy: p.receivedBy.fullName,
      note: p.note ?? '—',
    };
  });

  const totalCollected = sum(payments.map((p) => p.amount));

  return {
    from: query.from,
    to: query.to,
    summary: {
      totalCollected: toMoneyString(totalCollected),
      count: payments.length,
      tuitionTotal: toMoneyString(tuitionTotal),
      transportTotal: toMoneyString(transportTotal),
      admissionTotal: toMoneyString(admissionTotal),
      lateFeeTotal: toMoneyString(lateFeeTotal),
      cashTotal: toMoneyString(cashTotal),
      bankTotal: toMoneyString(bankTotal),
    },
    rows,
  };
}

export async function getExpenseLedgerAuditReport(query: { from: string; to: string; category?: string }) {
  const fromDate = parsePktDay(query.from);
  const toDate = parsePktDay(query.to);

  const expenses = await prisma.expense.findMany({
    where: {
      date: { gte: fromDate, lte: toDate },
      ...(query.category && query.category !== 'all' ? { category: query.category as ExpenseCategory } : {}),
    },
    include: {
      recordedBy: { select: { fullName: true } },
      funding: { include: { payer: { select: { fullName: true } } } },
      attachments: true,
    },
    orderBy: { date: 'desc' },
  });

  const byCategory = new Map<ExpenseCategory, Prisma.Decimal>();
  let personalFundingTotal = ZERO;

  const rows = expenses.map((e) => {
    byCategory.set(e.category, (byCategory.get(e.category) ?? ZERO).plus(e.amount));

    for (const f of e.funding) {
      if (f.payerType === 'ADMIN_PERSONAL' || f.payerType === 'TEACHER_PERSONAL') {
        personalFundingTotal = personalFundingTotal.plus(f.amount);
      }
    }

    return {
      id: e.id,
      title: e.title,
      category: e.category,
      date: pktDayString(e.date),
      amount: toMoneyString(e.amount),
      recordedBy: e.recordedBy.fullName,
      funding: e.funding.map((f) => ({
        payerType: f.payerType,
        payerName: f.payer?.fullName ?? null,
        amount: toMoneyString(f.amount),
      })),
      attachmentCount: e.attachments.length + (e.attachmentUrl ? 1 : 0),
    };
  });

  const totalExpenses = sum(expenses.map((e) => e.amount));

  return {
    from: query.from,
    to: query.to,
    summary: {
      totalExpenses: toMoneyString(totalExpenses),
      count: expenses.length,
      personalFundingTotal: toMoneyString(personalFundingTotal),
      byCategory: [...byCategory.entries()].map(([cat, amt]) => ({ category: cat, amount: toMoneyString(amt) })),
    },
    rows,
  };
}

export async function getPayrollRegisterReport(query: { year: number; month: number }) {
  const slips = await prisma.salarySlip.findMany({
    where: { year: query.year, month: query.month },
    include: {
      teacher: { include: { user: { select: { fullName: true, phone: true, avatarUrl: true } } } },
      generatedBy: { select: { fullName: true } },
    },
    orderBy: { teacher: { user: { fullName: 'asc' } } },
  });

  let totalBasic = ZERO;
  let totalDeductions = ZERO;
  let totalStaffFeeDeductions = ZERO;
  let totalNetPaid = ZERO;
  let paidCount = 0;
  let pendingCount = 0;

  const rows = slips.map((s) => {
    totalBasic = totalBasic.plus(s.basicSalary);
    totalDeductions = totalDeductions.plus(s.deductions);
    totalStaffFeeDeductions = totalStaffFeeDeductions.plus(s.staffFeeDeduction);
    totalNetPaid = totalNetPaid.plus(s.netSalary);

    if (s.status === 'PAID') paidCount += 1;
    else pendingCount += 1;

    return {
      id: s.id,
      employeeId: s.teacher.employeeId,
      name: s.teacher.user.fullName,
      phone: s.teacher.user.phone ?? '—',
      basicSalary: toMoneyString(s.basicSalary),
      allowances: toMoneyString(s.allowances),
      deductions: toMoneyString(s.deductions),
      staffFeeDeduction: toMoneyString(s.staffFeeDeduction),
      netSalary: toMoneyString(s.netSalary),
      status: s.status,
      paidDate: s.paidDate ? pktDayString(s.paidDate) : '—',
      avatarUrl: s.teacher.user.avatarUrl,
    };
  });

  return {
    summary: {
      year: query.year,
      month: query.month,
      count: slips.length,
      paidCount,
      pendingCount,
      totalBasic: toMoneyString(totalBasic),
      totalDeductions: toMoneyString(totalDeductions),
      totalStaffFeeDeductions: toMoneyString(totalStaffFeeDeductions),
      totalNetPaid: toMoneyString(totalNetPaid),
    },
    rows,
  };
}

export interface SavedReportQuery {
  reportType: string;
  periodType: string;
  year: number;
  month?: number | null;
  classId?: string | null;
  sectionId?: string | null;
}

export async function findSavedReport(q: SavedReportQuery) {
  return prisma.savedReport.findUnique({
    where: {
      reportType_periodType_year_month_classId_sectionId: {
        reportType: q.reportType,
        periodType: q.periodType,
        year: q.year,
        month: q.month ?? 0,
        classId: q.classId ?? 'all',
        sectionId: q.sectionId ?? 'all',
      },
    },
  });
}

export async function createSavedReport(q: SavedReportQuery, generatedBy: string) {
  let title = '';
  let data: any = null;

  const monthLabel = q.month ? MONTHS[q.month] : '';
  const periodLabel = q.periodType === 'monthly' ? `${monthLabel} ${q.year}` : `Year ${q.year}`;

  // Generate data based on report type
  if (q.reportType === 'roster') {
    title = `Student Roster & Directory (${periodLabel})`;
    data = await getStudentRosterReport({
      classId: q.classId ?? undefined,
      sectionId: q.sectionId ?? undefined,
    });
  } else if (q.reportType === 'defaulters') {
    title = `Fee Defaulters Audit (${periodLabel})`;
    data = await getFeeDefaultersReport({
      classId: q.classId ?? undefined,
      sectionId: q.sectionId ?? undefined,
    });
  } else if (q.reportType === 'student-summary') {
    title = `Student Attendance Summary (${periodLabel})`;
    data = await getStudentAttendanceSummaryReport({
      year: q.year,
      month: q.month ?? 1,
      classId: q.classId ?? undefined,
      sectionId: q.sectionId ?? undefined,
    });
  } else if (q.reportType === 'staff-summary') {
    title = `Staff Attendance Summary (${periodLabel})`;
    data = await getStaffAttendanceSummaryReport({
      year: q.year,
      month: q.month ?? 1,
    });
  } else if (q.reportType === 'daily-absentees') {
    // For daily absentees in saved reports, we use the first day of month or year
    const targetDate = q.periodType === 'monthly' ? `${q.year}-${String(q.month).padStart(2, '0')}-01` : `${q.year}-01-01`;
    title = `Daily Absentee Report (${targetDate})`;
    data = await getDailyAbsenteeReport({ date: targetDate });
  } else if (q.reportType === 'fees') {
    title = `Fee Collections Audit (${periodLabel})`;
    const from = q.periodType === 'monthly' ? `${q.year}-${String(q.month).padStart(2, '0')}-01` : `${q.year}-01-01`;
    const lastDay = q.month ? new Date(Date.UTC(q.year, q.month, 0)).getUTCDate() : 31;
    const to = q.periodType === 'monthly' ? `${q.year}-${String(q.month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}` : `${q.year}-12-31`;
    data = await getFeeCollectionsAuditReport({ from, to });
  } else if (q.reportType === 'expenses') {
    title = `Expense Ledger Audit (${periodLabel})`;
    const from = q.periodType === 'monthly' ? `${q.year}-${String(q.month).padStart(2, '0')}-01` : `${q.year}-01-01`;
    const lastDay = q.month ? new Date(Date.UTC(q.year, q.month, 0)).getUTCDate() : 31;
    const to = q.periodType === 'monthly' ? `${q.year}-${String(q.month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}` : `${q.year}-12-31`;
    data = await getExpenseLedgerAuditReport({ from, to });
  } else if (q.reportType === 'payroll') {
    title = `Payroll Register (${periodLabel})`;
    data = await getPayrollRegisterReport({
      year: q.year,
      month: q.month ?? 1,
    });
  } else {
    throw new AppError('Unknown report type', 400);
  }

  // Check if already exists, delete if so to overwrite
  const existing = await findSavedReport(q);
  if (existing) {
    await prisma.savedReport.delete({ where: { id: existing.id } });
  }

  return prisma.savedReport.create({
    data: {
      reportType: q.reportType,
      periodType: q.periodType,
      year: q.year,
      month: q.month ?? 0,
      classId: q.classId ?? 'all',
      sectionId: q.sectionId ?? 'all',
      title,
      data: data as any,
      generatedBy,
    },
  });
}

export async function deleteSavedReport(id: string) {
  return prisma.savedReport.delete({
    where: { id },
  });
}

export async function listSavedReports() {
  return prisma.savedReport.findMany({
    select: {
      id: true,
      reportType: true,
      title: true,
      periodType: true,
      year: true,
      month: true,
      classId: true,
      sectionId: true,
      generatedBy: true,
      generatedAt: true,
    },
    orderBy: {
      generatedAt: 'desc',
    },
  });
}


const MONTHS = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
];


