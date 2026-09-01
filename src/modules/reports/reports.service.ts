import { prisma } from '../../config/prisma';
import { parsePktDay, pktDayString, pktTime12HourString, periodWindow, isOnOrBeforePeriod } from '../../utils/pktDate';
import { toMoneyString, ZERO, sum, round2, money } from '../../utils/money';
import { outstandingAcross } from '../fees/fees.ledger';
import { payrollTotals, groupForRegister, groupTotals } from './reports.payroll';
import { AppError } from '../../utils/apiResponse';
import type { Prisma, ExpenseCategory, PayerType, PaymentMethod, Gender, UserStatus, AttendanceStatus } from '@prisma/client';
import { publicUrl } from '../../services/storage';
import { logAudit } from '../audit/audit.service';

export interface RosterQuery {
  classId?: string;
  sectionId?: string;
  gender?: string;
  status?: string;
  search?: string;
  /**
   * Exclude students admitted after this period. Omit for "everyone today".
   *
   * NOTE: `Student` records no leaving date, so a roster for a past period
   * cannot reconstruct who had already left — it reports current status for
   * everyone admitted by then. `asOf` in the response says so.
   */
  year?: number;
  /** 0 or absent with a `year` means the whole of that year. */
  month?: number | null;
}

export async function getStudentRosterReport(query: RosterQuery) {
  // Someone admitted in November cannot appear on an August roster.
  const admittedBy = query.year ? periodWindow(query.year, query.month).end : null;
  const rawSearch = (query.search ?? '').trim();
  const tokens = rawSearch.split(/\s+/).filter(Boolean);

  const where: Prisma.StudentWhereInput = {
    ...(admittedBy ? { admissionDate: { lte: admittedBy } } : {}),
    ...(query.classId && query.classId !== 'all' ? { section: { classId: query.classId } } : {}),
    ...(query.sectionId && query.sectionId !== 'all' ? { sectionId: query.sectionId } : {}),
    ...(query.gender && query.gender !== 'all' ? { gender: query.gender as Gender } : {}),
    ...(query.status && query.status !== 'all' ? { status: query.status as UserStatus } : {}),
    ...(tokens.length
      ? {
          OR: [
            { firstName: { contains: rawSearch, mode: 'insensitive' } },
            { lastName: { contains: rawSearch, mode: 'insensitive' } },
            {
              AND: tokens.map((token) => ({
                OR: [
                  { firstName: { contains: token, mode: 'insensitive' } },
                  { lastName: { contains: token, mode: 'insensitive' } },
                ],
              })),
            },
            { admissionNo: { contains: rawSearch, mode: 'insensitive' } },
            { rollNo: { contains: rawSearch, mode: 'insensitive' } },
            { parent: { user: { fullName: { contains: rawSearch, mode: 'insensitive' } } } },
            {
              parent: {
                user: {
                  AND: tokens.map((token) => ({
                    fullName: { contains: token, mode: 'insensitive' },
                  })),
                },
              },
            },
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
    summary: {
      total, active, inactive: total - active, male, female, withTransport,
      /**
       * Enrolment cut-off applied, or null when the roster is "as of today".
       * Formatted from the UTC components rather than via `pktDayString`: the
       * window ends at 23:59:59 UTC, so adding the +5 PKT offset would roll the
       * label into the following day (January reading as 01 February).
       */
      admittedBy: admittedBy ? admittedBy.toISOString().slice(0, 10) : null,
      /** True when statuses are current rather than historical — see RosterQuery. */
      statusIsCurrent: !!admittedBy,
    },
    students: students.map((s) => ({
      id: s.id,
      admissionNo: s.admissionNo,
      rollNo: s.rollNo ?? '—',
      name: `${s.firstName}${s.lastName ? ` ${s.lastName}` : ''}`,
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
      photoUrl: publicUrl(s.photoUrl),
      isStaffParent: !!s.teacherParentId || !!s.parent.user.teacherProfile,
    })),
  };
}

export interface DefaultersQuery {
  classId?: string;
  sectionId?: string;
  search?: string;
  /**
   * Count only bills raised up to this period. Omit for "everything owed
   * today". A snapshot titled "August 2026" previously ignored its own period
   * entirely and stored whatever was outstanding at the moment it was taken.
   */
  year?: number;
  /** 0 or absent with a `year` means the whole of that year. */
  month?: number | null;
  /**
   * Whose debt to list. Defaults to everyone, including students who have
   * left: a leaver's arrears are still owed and still get chased, and
   * restricting this to ACTIVE hid them from the one report used to chase
   * money. Pass 'ACTIVE' explicitly to get the old behaviour.
   */
  studentStatus?: 'all' | 'ACTIVE' | 'INACTIVE';
}

export async function getFeeDefaultersReport(query: DefaultersQuery) {
  const rawSearch = (query.search ?? '').trim();
  const tokens = rawSearch.split(/\s+/).filter(Boolean);

  const whereStudent: Prisma.StudentWhereInput = {
    ...(query.studentStatus && query.studentStatus !== 'all' ? { status: query.studentStatus } : {}),
    ...(query.classId && query.classId !== 'all' ? { section: { classId: query.classId } } : {}),
    ...(query.sectionId && query.sectionId !== 'all' ? { sectionId: query.sectionId } : {}),
    ...(tokens.length
      ? {
          OR: [
            { firstName: { contains: rawSearch, mode: 'insensitive' } },
            { lastName: { contains: rawSearch, mode: 'insensitive' } },
            {
              AND: tokens.map((token) => ({
                OR: [
                  { firstName: { contains: token, mode: 'insensitive' } },
                  { lastName: { contains: token, mode: 'insensitive' } },
                ],
              })),
            },
            { admissionNo: { contains: rawSearch, mode: 'insensitive' } },
            { rollNo: { contains: rawSearch, mode: 'insensitive' } },
            { parent: { user: { fullName: { contains: rawSearch, mode: 'insensitive' } } } },
            {
              parent: {
                user: {
                  AND: tokens.map((token) => ({
                    fullName: { contains: token, mode: 'insensitive' },
                  })),
                },
              },
            },
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

  /*
   * Bills raised up to the end of the requested period. Payments are NOT
   * date-limited: a March bill settled in August is settled, whenever the cash
   * arrived. So this answers "who is behind on bills up to <period>", which is
   * what selecting a period should mean.
   */
  const upToMonth = query.year ? (query.month || 12) : null;
  const inPeriod = (c: { year: number; month: number }) =>
    query.year == null || isOnOrBeforePeriod(c.year, c.month, query.year, upToMonth as number);

  const defaulters = students
    .map((s) => {
      // `balance = amount − non-reversed cash − staffCovered`. The arithmetic
      // that used to live here subtracted cash only, which billed staff parents
      // for fees already recovered from their salary.
      const dues = outstandingAcross(s.challans.filter(inPeriod));
      const totalUnpaid = dues.outstanding;
      const unpaidChallanCount = dues.unpaidCount;
      const unpaidMonths = dues.unpaid.map((c) => `${c.month}/${c.year}`);

      if (totalUnpaid.lessThanOrEqualTo(0)) return null;

      return {
        id: s.id,
        admissionNo: s.admissionNo,
        name: `${s.firstName}${s.lastName ? ` ${s.lastName}` : ''}`,
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
        photoUrl: publicUrl(s.photoUrl),
        isStaffParent: !!s.teacherParentId || !!s.parent.user.teacherProfile,
        /** A leaver still owes what they owe — flagged so chasing can differ. */
        studentStatus: s.status,
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
      /** Latest billing period counted, or null when this is "everything owed today". */
      billedUpTo: query.year ? `${String(upToMonth).padStart(2, '0')}/${query.year}` : null,
      /** Called out separately: a leaver's debt is harder to recover. */
      inactiveCount: defaulters.filter((d) => d.studentStatus !== 'ACTIVE').length,
      inactiveOutstanding: toMoneyString(
        sum(defaulters.filter((d) => d.studentStatus !== 'ACTIVE').map((d) => d.totalOutstanding)),
      ),
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
  const { start, end } = periodWindow(query.year, query.month);

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
      name: `${s.firstName}${s.lastName ? ` ${s.lastName}` : ''}`,
      className: s.section.class.name,
      sectionName: s.section.name,
      totalMarkedDays: totalMarked,
      present: counts.present,
      absent: counts.absent,
      leave: counts.leave,
      late: counts.late,
      attendancePct,
      photoUrl: publicUrl(s.photoUrl),
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
  const { start, end } = periodWindow(query.year, query.month);

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
      /** Teaching vs support staff, so the register can tell them apart. */
      staffRole: t.staffRole,
      phone: t.user.phone ?? '—',
      cnic: t.user.cnic ?? '—',
      totalMarkedDays: totalMarked,
      present: counts.present,
      absent: counts.absent,
      leave: counts.leave,
      late: counts.late,
      attendancePct,
      avatarUrl: publicUrl(t.user.avatarUrl),
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
    name: `${a.student.firstName}${a.student.lastName ? ` ${a.student.lastName}` : ''}`,
    className: a.student.section.class.name,
    sectionName: a.student.section.name,
    status: a.status,
    contactPerson: a.student.parent.user.fullName,
    contactPhone: a.student.parent.user.phone ?? '—',
    isStaffParent: !!a.student.teacherParentId || !!a.student.parent.user.teacherProfile,
    note: a.note ?? 'No note',
    photoUrl: publicUrl(a.student.photoUrl),
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
    avatarUrl: publicUrl(a.teacher.user.avatarUrl),
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
  let certificateTotal = ZERO;
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
        else if (item.type === 'CERTIFICATE') certificateTotal = certificateTotal.plus(itemShare);
        // Exam and ad-hoc charges. The variable is named lateFee for the
        // report's existing column, but a late fee is a challan column rather
        // than a line item, so nothing that is actually a late fee ever
        // reaches here.
        else lateFeeTotal = lateFeeTotal.plus(itemShare);
      }
    }

    return {
      id: p.id,
      date: pktDayString(p.paymentDate),
      studentName: `${p.student.firstName}${p.student.lastName ? ` ${p.student.lastName}` : ''}`,
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
      certificateTotal: toMoneyString(certificateTotal),
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

/**
 * Payroll register for one month, or for a whole year when `month` is omitted
 * or 0.
 *
 * Yearly collapses each employee's twelve slips into a single row of annual
 * totals — otherwise a "Year 2026" register would just be a list of twelve
 * separate rows per person. `monthsCovered` says how many slips a total is
 * built from, so a mid-year joiner is visibly on 7 months rather than looking
 * underpaid against colleagues on 12.
 */
export async function getPayrollRegisterReport(query: { year: number; month?: number | null }) {
  const isYearly = !query.month;

  const slips = await prisma.salarySlip.findMany({
    where: { year: query.year, ...(isYearly ? {} : { month: query.month as number }) },
    include: {
      teacher: { include: { user: { select: { fullName: true, phone: true, avatarUrl: true } } } },
      generatedBy: { select: { fullName: true } },
    },
    orderBy: [{ teacher: { user: { fullName: 'asc' } } }, { month: 'asc' }],
  });

  const overall = payrollTotals(slips);

  const rows = groupForRegister(slips, isYearly).map((group) => {
    const head = group[0];
    const t = groupTotals(group);
    return {
      id: head.id,
      employeeId: head.teacher.employeeId,
      name: head.teacher.user.fullName,
      staffRole: head.teacher.staffRole,
      phone: head.teacher.user.phone ?? '—',
      basicSalary: toMoneyString(t.basic),
      allowances: toMoneyString(t.allowances),
      deductions: toMoneyString(t.deductions),
      staffFeeDeduction: toMoneyString(t.staffFeeDeduction),
      netSalary: toMoneyString(t.net),
      status: t.status,
      paidDate: group.length === 1 && head.paidDate ? pktDayString(head.paidDate) : '—',
      avatarUrl: publicUrl(head.teacher.user.avatarUrl),
      /** Slips behind these totals — 1 monthly, up to 12 yearly. */
      monthsCovered: t.monthsCovered,
      paidMonths: t.paidCount,
      months: t.months,
    };
  });

  return {
    summary: {
      year: query.year,
      month: isYearly ? 0 : (query.month as number),
      isYearly,
      /** Employees on the register — NOT slip count, which differs when yearly. */
      count: rows.length,
      slipCount: slips.length,
      paidCount: overall.paidCount,
      pendingCount: overall.pendingCount,
      totalBasic: toMoneyString(overall.basic),
      totalDeductions: toMoneyString(overall.deductions),
      totalStaffFeeDeductions: toMoneyString(overall.staffFeeDeduction),
      /**
       * `totalNetPaid` now means what its name always claimed — disbursed only.
       * It previously held every slip, so pending payroll was reported as money
       * that had left the school. `totalNet` carries the full commitment.
       */
      totalNetPaid: toMoneyString(overall.netPaid),
      totalNetPending: toMoneyString(overall.netPending),
      totalNet: toMoneyString(overall.net),
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

  /*
   * Yearly reaches the period-aware reports as month 0, which they all read as
   * "the whole year". The previous `q.month ?? 1` turned a yearly request into
   * January and still titled it "Year XXXX", so a yearly payroll or attendance
   * snapshot silently held one month of data.
   */
  const yearly = q.periodType === 'yearly';

  // Generate data based on report type
  if (q.reportType === 'roster') {
    title = `Student Roster & Directory (${periodLabel})`;
    data = await getStudentRosterReport({
      classId: q.classId ?? undefined,
      sectionId: q.sectionId ?? undefined,
      year: q.year,
      month: yearly ? 0 : (q.month ?? 1),
    });
  } else if (q.reportType === 'defaulters') {
    title = `Fee Defaulters Audit (${periodLabel})`;
    data = await getFeeDefaultersReport({
      classId: q.classId ?? undefined,
      sectionId: q.sectionId ?? undefined,
      year: q.year,
      month: yearly ? 0 : (q.month ?? 1),
    });
  } else if (q.reportType === 'student-summary') {
    title = `Student Attendance Summary (${periodLabel})`;
    data = await getStudentAttendanceSummaryReport({
      year: q.year,
      month: yearly ? 0 : (q.month ?? 1),
      classId: q.classId ?? undefined,
      sectionId: q.sectionId ?? undefined,
    });
  } else if (q.reportType === 'staff-summary') {
    title = `Staff Attendance Summary (${periodLabel})`;
    data = await getStaffAttendanceSummaryReport({
      year: q.year,
      month: yearly ? 0 : (q.month ?? 1),
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
      month: yearly ? 0 : (q.month ?? 1),
    });
  } else {
    throw new AppError('Unknown report type', 400);
  }

  // Check if already exists, delete if so to overwrite
  const existing = await findSavedReport(q);
  if (existing) {
    await prisma.savedReport.delete({ where: { id: existing.id } });
  }

  const saved = await prisma.savedReport.create({
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

  /*
   * Audited by the caller (reports.controller `createSaved`), which has the
   * request for IP capture and the real actor id — same arrangement as
   * `deleteSavedReport` below.
   *
   * This used to log here as well, which produced two entries per snapshot.
   * The second was also misattributed: `generatedBy` is a display name, so
   * passing it as `actorId` resolved to no user and the row was stamped
   * "System Admin"/ADMIN, crediting the action to someone who never took it.
   *
   * `replacedPrevious` is returned rather than logged so the caller can still
   * record that a snapshot silently overwrote an earlier one for the period.
   */
  return { report: saved, replacedPrevious: Boolean(existing) };
}

/** Deletion is audited by the caller (reports.controller `removeSaved`), which
 *  has the request for IP capture — doing it here as well would double-log. */
export async function deleteSavedReport(id: string) {
  return prisma.savedReport.delete({ where: { id } });
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


