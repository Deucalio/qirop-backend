import { prisma } from '../../config/prisma';
import { parsePktDay, pktDayString, pktTime12HourString } from '../../utils/pktDate';
import { toMoneyString, ZERO, sum, round2, money } from '../../utils/money';
import { outstandingAcross } from '../fees/fees.ledger';
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
      parent: { include: { user: { select: { fullName: true, phone: true, cnic: true, teacherProfile: { select: { id: true } } } } } },
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
      isStaffParent: !!s.teacherParentId || !!s.parent.user.teacherProfile,
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
      parent: { include: { user: { select: { fullName: true, phone: true, teacherProfile: { select: { id: true } } } } } },
      /*
       * Deliberately NOT filtered on the stored `status`. That column is a
       * cache of `deriveStatus`, and this report decides who gets chased for
       * money — so it re-derives every balance from the ledger itself rather
       * than trusting a denormalised field. `payment.isReversed` is pulled in
       * because `paidBreakdown` must discount reversed receipts.
       */
      challans: {
        include: { allocations: { include: { payment: { select: { isReversed: true } } } } },
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
      // `balance = amount − non-reversed cash − staffCovered`. The arithmetic
      // that used to live here subtracted cash only, which billed staff parents
      // for fees already recovered from their salary.
      const dues = outstandingAcross(s.challans);
      const totalUnpaid = dues.outstanding;
      const unpaidChallanCount = dues.unpaidCount;
      const unpaidMonths = dues.unpaid.map((c) => `${c.month}/${c.year}`);

      if (totalUnpaid.lessThanOrEqualTo(0)) return null;

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
        /** Already recovered from a staff parent's salary — not owed in cash. */
        staffCovered: toMoneyString(dues.staffCovered),
        lastPaymentDate: s.payments[0] ? pktDayString(s.payments[0].paymentDate) : 'No payments',
        photoUrl: s.photoUrl,
        isStaffParent: !!s.teacherParentId || !!s.parent.user.teacherProfile,
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

const MONTH_NAMES_LIST = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

export async function getStudentAttendanceSummaryReport(query: StudentAttendanceSummaryQuery) {
  const isYearly = !query.month || query.month === 0;
  const start = isYearly ? new Date(Date.UTC(query.year, 0, 1)) : new Date(Date.UTC(query.year, query.month - 1, 1));
  const end = isYearly ? new Date(Date.UTC(query.year, 11, 31, 23, 59, 59)) : new Date(Date.UTC(query.year, query.month, 0, 23, 59, 59));

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
      select: { id: true, studentId: true, status: true, date: true, createdAt: true, note: true },
      orderBy: { date: 'asc' },
    }),
  ]);

  const distinctDays = new Set(attendanceRecords.map((r) => r.date.toISOString().slice(0, 10))).size;
  const attMap = new Map<string, { present: number; absent: number; leave: number; late: number }>();
  const monthlyMap = new Map<string, Map<number, { present: number; absent: number; leave: number; late: number; markedTime?: string; dailyLogs: any[] }>>();

  for (const r of attendanceRecords) {
    const cur = attMap.get(r.studentId) ?? { present: 0, absent: 0, leave: 0, late: 0 };
    if (r.status === 'PRESENT') cur.present += 1;
    else if (r.status === 'ABSENT') cur.absent += 1;
    else if (r.status === 'LEAVE') cur.leave += 1;
    else if (r.status === 'LATE') cur.late += 1;
    attMap.set(r.studentId, cur);

    const m = r.date.getUTCMonth();
    let studentMonths = monthlyMap.get(r.studentId);
    if (!studentMonths) {
      studentMonths = new Map();
      monthlyMap.set(r.studentId, studentMonths);
    }
    const mCur = studentMonths.get(m) ?? { present: 0, absent: 0, leave: 0, late: 0, dailyLogs: [] };
    if (r.status === 'PRESENT') mCur.present += 1;
    else if (r.status === 'ABSENT') mCur.absent += 1;
    else if (r.status === 'LEAVE') mCur.leave += 1;
    else if (r.status === 'LATE') mCur.late += 1;

    const pktDateStr = pktDayString(r.date);
    const dayName = new Date(r.date).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'Asia/Karachi' });
    const pktTime = r.createdAt ? pktTime12HourString(r.createdAt) : '—';
    
    if (!mCur.markedTime) {
      mCur.markedTime = pktTime;
    }

    mCur.dailyLogs.push({
      id: r.id,
      date: pktDateStr,
      dayName,
      status: r.status,
      markedTime: pktTime,
      note: r.note ?? null,
    });

    studentMonths.set(m, mCur);
  }

  const rows = students.map((s) => {
    const counts = attMap.get(s.id) ?? { present: 0, absent: 0, leave: 0, late: 0 };
    const totalMarked = counts.present + counts.absent + counts.leave + counts.late;
    const effectivePresent = counts.present + counts.late;
    const attendancePct = totalMarked > 0 ? Math.round((effectivePresent / totalMarked) * 100) : 0;

    const studentMonths = monthlyMap.get(s.id);
    const monthlyBreakdown = MONTH_NAMES_LIST.map((mName, idx) => {
      const mData = studentMonths?.get(idx) ?? { present: 0, absent: 0, leave: 0, late: 0, dailyLogs: [] };
      const mTotal = mData.present + mData.absent + mData.leave + mData.late;
      const mEff = mData.present + mData.late;
      const mPct = mTotal > 0 ? Math.round((mEff / mTotal) * 100) : 0;
      return {
        month: idx + 1,
        monthName: mName,
        present: mData.present,
        absent: mData.absent,
        leave: mData.leave,
        late: mData.late,
        totalMarkedDays: mTotal,
        attendancePct: mPct,
        markedTime: mData.markedTime ?? '—',
        dailyLogs: (mData.dailyLogs || []).sort((a: any, b: any) => a.date.localeCompare(b.date)),
      };
    });

    const selectedMonthIdx = query.month > 0 ? query.month - 1 : null;
    const dailyLogs = selectedMonthIdx !== null ? (monthlyBreakdown[selectedMonthIdx]?.dailyLogs || []) : [];

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
      monthlyBreakdown,
      dailyLogs,
    };
  });

  const totalRecords = rows.reduce((s, r) => s + r.totalMarkedDays, 0);
  const totalPresent = rows.reduce((s, r) => s + r.present + r.late, 0);
  const overallClassPct = totalRecords > 0 ? Math.round((totalPresent / totalRecords) * 100) : 0;

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
  const isYearly = !query.month || query.month === 0;
  const start = isYearly ? new Date(Date.UTC(query.year, 0, 1)) : new Date(Date.UTC(query.year, query.month - 1, 1));
  const end = isYearly ? new Date(Date.UTC(query.year, 11, 31, 23, 59, 59)) : new Date(Date.UTC(query.year, query.month, 0, 23, 59, 59));

  const [teachers, attendanceRecords] = await Promise.all([
    prisma.teacherProfile.findMany({
      where: { status: 'ACTIVE' },
      include: { user: { select: { fullName: true, phone: true, avatarUrl: true, cnic: true } } },
      orderBy: { user: { fullName: 'asc' } },
    }),
    prisma.teacherAttendance.findMany({
      where: { date: { gte: start, lte: end } },
      select: { id: true, teacherId: true, status: true, date: true, checkInTime: true, createdAt: true },
      orderBy: { date: 'asc' },
    }),
  ]);

  const distinctDays = new Set(attendanceRecords.map((r) => r.date.toISOString().slice(0, 10))).size;
  const attMap = new Map<string, { present: number; absent: number; leave: number; late: number }>();
  const monthlyMap = new Map<string, Map<number, { present: number; absent: number; leave: number; late: number; markedTime?: string; dailyLogs: any[] }>>();

  for (const r of attendanceRecords) {
    const cur = attMap.get(r.teacherId) ?? { present: 0, absent: 0, leave: 0, late: 0 };
    if (r.status === 'PRESENT') cur.present += 1;
    else if (r.status === 'ABSENT') cur.absent += 1;
    else if (r.status === 'LEAVE') cur.leave += 1;
    else if (r.status === 'LATE') cur.late += 1;
    attMap.set(r.teacherId, cur);

    const m = r.date.getUTCMonth();
    let teacherMonths = monthlyMap.get(r.teacherId);
    if (!teacherMonths) {
      teacherMonths = new Map();
      monthlyMap.set(r.teacherId, teacherMonths);
    }
    const mCur = teacherMonths.get(m) ?? { present: 0, absent: 0, leave: 0, late: 0, dailyLogs: [] };
    if (r.status === 'PRESENT') mCur.present += 1;
    else if (r.status === 'ABSENT') mCur.absent += 1;
    else if (r.status === 'LEAVE') mCur.leave += 1;
    else if (r.status === 'LATE') mCur.late += 1;

    const pktDateStr = pktDayString(r.date);
    const dayName = new Date(r.date).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'Asia/Karachi' });
    const rawDate = r.checkInTime ?? r.createdAt;
    const pktTime = rawDate ? pktTime12HourString(rawDate) : '—';
    
    if (!mCur.markedTime) {
      mCur.markedTime = pktTime;
    }

    mCur.dailyLogs.push({
      id: r.id,
      date: pktDateStr,
      dayName,
      status: r.status,
      markedTime: pktTime,
      note: null,
    });

    teacherMonths.set(m, mCur);
  }

  const rows = teachers.map((t) => {
    const counts = attMap.get(t.id) ?? { present: 0, absent: 0, leave: 0, late: 0 };
    const totalMarked = counts.present + counts.absent + counts.leave + counts.late;
    const effectivePresent = counts.present + counts.late;
    const attendancePct = totalMarked > 0 ? Math.round((effectivePresent / totalMarked) * 100) : 0;

    const teacherMonths = monthlyMap.get(t.id);
    const monthlyBreakdown = MONTH_NAMES_LIST.map((mName, idx) => {
      const mData = teacherMonths?.get(idx) ?? { present: 0, absent: 0, leave: 0, late: 0, dailyLogs: [] };
      const mTotal = mData.present + mData.absent + mData.leave + mData.late;
      const mEff = mData.present + mData.late;
      const mPct = mTotal > 0 ? Math.round((mEff / mTotal) * 100) : 0;
      return {
        month: idx + 1,
        monthName: mName,
        present: mData.present,
        absent: mData.absent,
        leave: mData.leave,
        late: mData.late,
        totalMarkedDays: mTotal,
        attendancePct: mPct,
        markedTime: mData.markedTime ?? '—',
        dailyLogs: (mData.dailyLogs || []).sort((a: any, b: any) => a.date.localeCompare(b.date)),
      };
    });

    const selectedMonthIdx = query.month > 0 ? query.month - 1 : null;
    const dailyLogs = selectedMonthIdx !== null ? (monthlyBreakdown[selectedMonthIdx]?.dailyLogs || []) : [];

    return {
      id: t.id,
      employeeId: t.employeeId,
      name: t.user.fullName,
      phone: t.user.phone ?? '—',
      cnic: t.user.cnic ?? '—',
      totalMarkedDays: totalMarked,
      present: counts.present,
      absent: counts.absent,
      leave: counts.leave,
      late: counts.late,
      attendancePct,
      avatarUrl: t.user.avatarUrl,
      monthlyBreakdown,
      dailyLogs,
    };
  });

  const totalRecords = rows.reduce((s, r) => s + r.totalMarkedDays, 0);
  const totalPresent = rows.reduce((s, r) => s + r.present + r.late, 0);
  const overallStaffPct = totalRecords > 0 ? Math.round((totalPresent / totalRecords) * 100) : 0;

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

export async function getDailyAbsenteeReport(query: { date?: string; from?: string; to?: string }) {
  let dateWhere: Prisma.DateTimeFilter;
  if (query.from && query.to) {
    const start = parsePktDay(query.from);
    const end = parsePktDay(query.to);
    end.setUTCHours(23, 59, 59, 999);
    dateWhere = { gte: start, lte: end };
  } else {
    const targetDate = parsePktDay(query.date ?? pktDayString(new Date()));
    dateWhere = { equals: targetDate };
  }

  const [studentAbsentees, teacherAbsentees] = await Promise.all([
    prisma.studentAttendance.findMany({
      where: { date: dateWhere, status: { in: ['ABSENT', 'LEAVE'] } },
      include: {
        student: {
          include: {
            section: { include: { class: true } },
            parent: { include: { user: { select: { fullName: true, phone: true, teacherProfile: { select: { id: true } } } } } },
          },
        },
      },
    }),
    prisma.teacherAttendance.findMany({
      where: { date: dateWhere, status: { in: ['ABSENT', 'LEAVE'] } },
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
    isStaffParent: !!a.student.teacherParentId || !!a.student.parent.user.teacherProfile,
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
    isStaffParent: true,
    note: 'Staff absence',
    avatarUrl: a.teacher.user.avatarUrl,
  }));

  return {
    date: query.date ?? `${query.from} to ${query.to}`,
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
  // Money received that is not applied to any challan — an advance paid before
  // the bill existed, or a receipt whose challans were later deleted. It is
  // real cash, but it belongs to no fee head, so without tracking it here the
  // tuition/transport/admission split silently fails to add up to the total.
  let unallocatedTotal = ZERO;

  const rows = payments.map((p) => {
    if (p.method === 'CASH') cashTotal = cashTotal.plus(p.amount);
    else bankTotal = bankTotal.plus(p.amount);

    const applied = sum(p.allocations.map((a) => a.amountApplied));
    const rowUnallocated = round2(money(p.amount).minus(applied));
    if (rowUnallocated.greaterThan(0)) unallocatedTotal = unallocatedTotal.plus(rowUnallocated);

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
      /** Part of this receipt not applied to any challan. '0.00' when fully applied. */
      unallocated: toMoneyString(rowUnallocated.greaterThan(0) ? rowUnallocated : ZERO),
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
      unallocatedTotal: toMoneyString(unallocatedTotal),
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
    const from = q.periodType === 'monthly' ? `${q.year}-${String(q.month).padStart(2, '0')}-01` : `${q.year}-01-01`;
    const lastDay = q.month ? new Date(Date.UTC(q.year, q.month, 0)).getUTCDate() : 31;
    const to = q.periodType === 'monthly' ? `${q.year}-${String(q.month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}` : `${q.year}-12-31`;
    title = `Daily Absentee Report (${periodLabel})`;
    data = await getDailyAbsenteeReport({ from, to });
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


