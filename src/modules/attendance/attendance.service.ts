import { AttendanceStatus, PermissionModule, Role, UserStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError, Forbidden, NotFound } from '../../utils/apiResponse';
import { userHasPermission } from '../../utils/permissions';
import { publicUrl } from '../../services/storage';
import { summarize } from '../../utils/attendanceMetrics';
import { logAudit } from '../audit/audit.service';
import {
  pktDay,
  pktDayString,
  parsePktDay,
  isFuturePktDay,
  lastNPktDays,
  pktMonthRange,
} from '../../utils/pktDate';

export interface Actor {
  userId: string;
  role: Role;
}

const ATTENDANCE = PermissionModule.ATTENDANCE;

// ===========================================================================
// Teacher self attendance
// ===========================================================================

async function teacherProfileByUser(userId: string) {
  const profile = await prisma.teacherProfile.findUnique({ where: { userId } });
  if (!profile) throw NotFound('Teacher profile not found');
  return profile;
}

export async function checkIn(userId: string) {
  const profile = await prisma.teacherProfile.findUnique({
    where: { userId },
    include: { user: true },
  });
  if (!profile) throw NotFound('Teacher profile not found');
  const date = pktDay();
  const existing = await prisma.teacherAttendance.findUnique({
    where: { teacherId_date: { teacherId: profile.id, date } },
  });
  // Stamp the time on first check-in; preserve it on subsequent ones (idempotent).
  const checkInTime = existing?.checkInTime ?? new Date();
  const record = await prisma.teacherAttendance.upsert({
    where: { teacherId_date: { teacherId: profile.id, date } },
    update: { status: AttendanceStatus.PRESENT, checkInTime },
    create: { teacherId: profile.id, date, status: AttendanceStatus.PRESENT, checkInTime },
  });

  await logAudit(null, {
    actorId: userId,
    actorName: profile.user.fullName,
    actorRole: profile.user.role,
    action: 'CHECKIN',
    module: 'ATTENDANCE',
    targetType: 'TeacherProfile',
    targetId: profile.id,
    targetLabel: `${profile.user.fullName} Self Check-In`,
    details: `${profile.user.fullName} recorded teacher self check-in for ${pktDayString(date)}`,
  });

  return { date: pktDayString(date), status: record.status, checkInTime: record.checkInTime };
}

export async function getMyTeacherAttendance(userId: string, year?: number, month?: number) {
  const profile = await teacherProfileByUser(userId);
  const now = pktDay();
  const y = year ?? now.getUTCFullYear();
  const m = month ?? now.getUTCMonth() + 1;
  const { start, endExclusive } = pktMonthRange(y, m);

  const records = await prisma.teacherAttendance.findMany({
    where: { teacherId: profile.id, date: { gte: start, lt: endExclusive } },
    orderBy: { date: 'asc' },
  });
  const todayRec = await prisma.teacherAttendance.findUnique({
    where: { teacherId_date: { teacherId: profile.id, date: now } },
  });

  return {
    year: y,
    month: m,
    today: {
      date: pktDayString(now),
      status: todayRec?.status ?? 'UNMARKED',
      checkInTime: todayRec?.checkInTime ?? null,
    },
    records: records.map((r) => ({ date: pktDayString(r.date), status: r.status, checkInTime: r.checkInTime })),
    summary: summarize(records.map((r) => r.status)),
  };
}

// ===========================================================================
// Admin: teacher attendance
// ===========================================================================

export async function setTeacherAttendance(
  teacherId: string,
  dateStr: string,
  status: AttendanceStatus,
  checkInTime?: string | null,
  actorId?: string,
) {
  const teacher = await prisma.teacherProfile.findUnique({
    where: { id: teacherId },
    include: { user: true },
  });
  if (!teacher) throw NotFound('Teacher not found');
  const date = parsePktDay(dateStr);
  if (isFuturePktDay(date)) throw new AppError('Cannot mark attendance for a future date', 400, 'FUTURE_DATE');

  const existing = await prisma.teacherAttendance.findUnique({
    where: { teacherId_date: { teacherId, date } },
  });

  const record = await prisma.teacherAttendance.upsert({
    where: { teacherId_date: { teacherId, date } },
    update: { status, checkInTime: checkInTime ? new Date(checkInTime) : null },
    create: { teacherId, date, status, checkInTime: checkInTime ? new Date(checkInTime) : null },
  });

  await logAudit(null, {
    actorId: actorId ?? null,
    action: 'UPDATE',
    module: 'ATTENDANCE',
    targetType: 'Teacher',
    targetId: teacherId,
    targetLabel: `${teacher.user.fullName}`,
    details: `Updated teacher attendance for ${teacher.user.fullName} to ${status} on ${dateStr}`,
    changes: {
      status: { before: existing?.status ?? 'UNMARKED', after: status },
      _meta: {
        photoUrl: teacher.user.avatarUrl,
        teacherName: teacher.user.fullName,
        date: dateStr,
      },
    },
  });

  return { teacherId, date: pktDayString(date), status: record.status, checkInTime: record.checkInTime };
}

export async function listTeacherAttendance(dateStr?: string) {
  const date = dateStr ? parsePktDay(dateStr) : pktDay();
  const teachers = await prisma.teacherProfile.findMany({
    include: { user: true },
    orderBy: { user: { fullName: 'asc' } },
  });
  const marks = await prisma.teacherAttendance.findMany({ where: { date } });
  const byTeacher = new Map(marks.map((m) => [m.teacherId, m]));

  const rows = teachers.map((t) => {
    const m = byTeacher.get(t.id);
    return {
      teacherId: t.id,
      fullName: t.user.fullName,
      employeeId: t.employeeId,
      status: (m?.status ?? 'UNMARKED') as AttendanceStatus | 'UNMARKED',
      checkInTime: m?.checkInTime ?? null,
    };
  });
  return {
    date: pktDayString(date),
    summary: summarize(marks.map((m) => m.status)),
    teachers: rows,
  };
}

// ===========================================================================
// Student attendance (section marking)
// ===========================================================================

/** Authorize an actor against a section for view/edit. Returns whether they may edit. */
async function authorizeSection(actor: Actor, section: { classTeacherId: string | null }, action: 'view' | 'edit') {
  if (actor.role === Role.TEACHER) {
    const profile = await prisma.teacherProfile.findUnique({ where: { userId: actor.userId }, select: { id: true } });
    const isClassTeacher = !!profile && section.classTeacherId === profile.id;
    if (!isClassTeacher) {
      throw Forbidden("Only this section's class teacher or an admin can access its attendance");
    }
    return true; // class teacher may view and edit
  }
  const canEdit = await userHasPermission(actor.userId, actor.role, ATTENDANCE, 'edit');
  const canView = await userHasPermission(actor.userId, actor.role, ATTENDANCE, 'view');
  if (action === 'edit' && !canEdit) throw Forbidden('You do not have permission to mark attendance');
  if (action === 'view' && !canView) throw Forbidden('You do not have permission to view attendance');
  return canEdit;
}

async function loadSection(sectionId: string) {
  const section = await prisma.section.findUnique({
    where: { id: sectionId },
    include: { class: true, classTeacher: { include: { user: true } } },
  });
  if (!section) throw NotFound('Section not found');
  return section;
}

export async function getSectionRoster(actor: Actor, sectionId: string, dateStr?: string) {
  const section = await loadSection(sectionId);
  const canEdit = await authorizeSection(actor, section, 'view');
  const date = dateStr ? parsePktDay(dateStr) : pktDay();

  const students = await prisma.student.findMany({
    where: { sectionId, status: UserStatus.ACTIVE },
    orderBy: [{ rollNo: 'asc' }, { firstName: 'asc' }],
  });
  const marks = await prisma.studentAttendance.findMany({
    where: { sectionId, date, studentId: { in: students.map((s) => s.id) } },
  });
  const byStudent = new Map(marks.map((m) => [m.studentId, m]));

  return {
    sectionId: section.id,
    sectionName: section.name,
    classId: section.classId,
    className: section.class.name,
    date: pktDayString(date),
    isFuture: isFuturePktDay(date),
    canEdit,
    classTeacher: section.classTeacher
      ? { id: section.classTeacher.id, fullName: section.classTeacher.user.fullName }
      : null,
    records: students.map((s) => {
      const m = byStudent.get(s.id);
      return {
        studentId: s.id,
        name: `${s.firstName} ${s.lastName}`,
        rollNo: s.rollNo,
        photoUrl: publicUrl(s.photoUrl),
        status: (m?.status ?? 'UNMARKED') as AttendanceStatus | 'UNMARKED',
        note: m?.note ?? null,
      };
    }),
  };
}

export async function getSectionMonthlyAttendance(actor: Actor, sectionId: string, yearNum?: number, monthNum?: number) {
  const section = await loadSection(sectionId);
  const canEdit = await authorizeSection(actor, section, 'view');

  const now = pktDay();
  const y = yearNum ?? now.getUTCFullYear();
  const m = monthNum ?? now.getUTCMonth() + 1;
  const { start, endExclusive } = pktMonthRange(y, m);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

  const students = await prisma.student.findMany({
    where: { sectionId, status: UserStatus.ACTIVE },
    orderBy: [{ rollNo: 'asc' }, { firstName: 'asc' }],
  });

  const marks = await prisma.studentAttendance.findMany({
    where: { sectionId, date: { gte: start, lt: endExclusive } },
  });

  const byStudent = new Map<string, Record<string, AttendanceStatus>>();
  for (const mark of marks) {
    const dateKey = pktDayString(mark.date);
    const studentMap = byStudent.get(mark.studentId) ?? {};
    studentMap[dateKey] = mark.status;
    byStudent.set(mark.studentId, studentMap);
  }

  let sundayCount = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const dayOfWeek = new Date(y, m - 1, day).getDay();
    if (dayOfWeek === 0) sundayCount++;
  }

  return {
    sectionId: section.id,
    sectionName: section.name,
    classId: section.classId,
    className: section.class.name,
    year: y,
    month: m,
    daysInMonth,
    canEdit,
    classTeacher: section.classTeacher
      ? { id: section.classTeacher.id, fullName: section.classTeacher.user.fullName }
      : null,
    students: students.map((s) => {
      const days = byStudent.get(s.id) ?? {};
      let presentCount = 0;
      let absentCount = 0;

      Object.values(days).forEach((st) => {
        if (st === 'PRESENT' || st === 'LATE') presentCount++;
        else if (st === 'ABSENT' || st === 'LEAVE') absentCount++;
      });

      return {
        id: s.id,
        name: `${s.firstName} ${s.lastName}`,
        rollNo: s.rollNo,
        photoUrl: publicUrl(s.photoUrl),
        days,
        summary: {
          present: presentCount,
          absent: absentCount,
          holiday: sundayCount,
          totalMarked: Object.keys(days).length,
        },
      };
    }),
  };
}

export async function getTeachersMonthlyAttendance(yearNum?: number, monthNum?: number) {
  const now = pktDay();
  const y = yearNum ?? now.getUTCFullYear();
  const m = monthNum ?? now.getUTCMonth() + 1;
  const { start, endExclusive } = pktMonthRange(y, m);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

  const teachers = await prisma.teacherProfile.findMany({
    include: { user: true },
    orderBy: { user: { fullName: 'asc' } },
  });

  const marks = await prisma.teacherAttendance.findMany({
    where: { date: { gte: start, lt: endExclusive } },
  });

  const byTeacher = new Map<string, Record<string, AttendanceStatus>>();
  for (const mark of marks) {
    const dateKey = pktDayString(mark.date);
    const teacherMap = byTeacher.get(mark.teacherId) ?? {};
    teacherMap[dateKey] = mark.status;
    byTeacher.set(mark.teacherId, teacherMap);
  }

  let sundayCount = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const dayOfWeek = new Date(y, m - 1, day).getDay();
    if (dayOfWeek === 0) sundayCount++;
  }

  return {
    year: y,
    month: m,
    daysInMonth,
    teachers: teachers.map((t) => {
      const days = byTeacher.get(t.id) ?? {};
      let presentCount = 0;
      let absentCount = 0;

      Object.values(days).forEach((st) => {
        if (st === 'PRESENT' || st === 'LATE') presentCount++;
        else if (st === 'ABSENT' || st === 'LEAVE') absentCount++;
      });

      return {
        id: t.id,
        name: t.user.fullName,
        employeeId: t.employeeId,
        days,
        summary: {
          present: presentCount,
          absent: absentCount,
          holiday: sundayCount,
          totalMarked: Object.keys(days).length,
        },
      };
    }),
  };
}

export async function markTeachersBatch(records: { teacherId: string; date: string; status: AttendanceStatus }[]) {
  await prisma.$transaction(
    records.map((r) => {
      const d = parsePktDay(r.date);
      return prisma.teacherAttendance.upsert({
        where: { teacherId_date: { teacherId: r.teacherId, date: d } },
        update: { status: r.status },
        create: { teacherId: r.teacherId, date: d, status: r.status },
      });
    })
  );
  return { success: true };
}

export async function markSection(
  actor: Actor,
  sectionId: string,
  dateStr: string,
  records: { studentId: string; status: AttendanceStatus; note?: string | null }[],
) {
  const section = await loadSection(sectionId);
  await authorizeSection(actor, section, 'edit');

  const date = parsePktDay(dateStr);
  if (isFuturePktDay(date)) throw new AppError('Cannot mark attendance for a future date', 400, 'FUTURE_DATE');

  // Fetch active students with full names to log human readable diffs
  const activeStudents = await prisma.student.findMany({
    where: { sectionId, status: UserStatus.ACTIVE },
    select: { id: true, firstName: true, lastName: true, rollNo: true },
  });
  const studentMap = new Map(activeStudents.map((s) => [s.id, s]));
  const validIds = new Set(activeStudents.map((s) => s.id));
  const stray = records.map((r) => r.studentId).filter((id) => !validIds.has(id));
  if (stray.length > 0) {
    throw new AppError('Some students do not belong to this section (or are inactive)', 400, 'INVALID_STUDENT', { stray });
  }

  // Fetch previous attendance status for before/after diff tracking
  const previousRecords = await prisma.studentAttendance.findMany({
    where: { sectionId, date, studentId: { in: records.map((r) => r.studentId) } },
  });
  const prevStatusMap = new Map(previousRecords.map((r) => [r.studentId, r.status]));

  await prisma.$transaction(
    records.map((r) =>
      prisma.studentAttendance.upsert({
        where: { studentId_date: { studentId: r.studentId, date } },
        update: { status: r.status, note: r.note ?? null, markedById: actor.userId, sectionId },
        create: { studentId: r.studentId, sectionId, date, status: r.status, note: r.note ?? null, markedById: actor.userId },
      }),
    ),
  );

  // Compile summary stats & diffs
  let present = 0, absent = 0, late = 0, leave = 0;
  const changes: Record<string, any> = {};

  for (const r of records) {
    if (r.status === AttendanceStatus.PRESENT) present++;
    else if (r.status === AttendanceStatus.ABSENT) absent++;
    else if (r.status === AttendanceStatus.LATE) late++;
    else if (r.status === AttendanceStatus.LEAVE) leave++;

    const prevStatus = prevStatusMap.get(r.studentId);
    if (prevStatus && prevStatus !== r.status) {
      const student = studentMap.get(r.studentId);
      const studentLabel = student ? `${student.firstName} ${student.lastName}` : `Student #${r.studentId.slice(0, 6)}`;
      changes[studentLabel] = { before: prevStatus, after: r.status };
    }
  }

  const actorUser = await prisma.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });
  const rawClassName = section.class.name.trim();
  const cleanClassName = rawClassName.toLowerCase().startsWith('class') ? rawClassName : `Class ${rawClassName}`;
  const sectionLabel = section.name ? `${cleanClassName}-${section.name}` : cleanClassName;
  const details = `${actorUser?.fullName ?? 'Teacher'} marked attendance for ${sectionLabel} (${present} Present, ${absent} Absent, ${late} Late, ${leave} Leave)`;

  changes._meta = {
    className: section.class.name,
    sectionName: section.name,
    date: dateStr,
    totalStudents: records.length,
    present,
    absent,
  };

  const actionVerb = previousRecords.length > 0 ? 'UPDATE' : 'CREATE';

  await logAudit(null, {
    actorId: actor.userId,
    actorName: actorUser?.fullName ?? 'Teacher',
    actorRole: actor.role,
    action: actionVerb,
    module: 'ATTENDANCE',
    targetType: 'ClassSection',
    targetId: sectionId,
    targetLabel: `${sectionLabel} Roster`,
    details,
    changes,
  });

  return getSectionRoster(actor, sectionId, dateStr);
}

// ===========================================================================
// Admin: attendance views & dashboard stats
// ===========================================================================

export async function getAttendanceByDate(dateStr?: string, classId?: string, sectionId?: string) {
  const date = dateStr ? parsePktDay(dateStr) : pktDay();
  const sections = await prisma.section.findMany({
    where: { classId, id: sectionId },
    include: {
      class: true,
      classTeacher: { include: { user: true } },
      _count: { select: { students: { where: { status: UserStatus.ACTIVE } } } },
    },
    orderBy: [{ class: { order: 'asc' } }, { name: 'asc' }],
  });
  const sectionIds = sections.map((s) => s.id);
  const marks = await prisma.studentAttendance.findMany({
    where: { date, sectionId: { in: sectionIds } },
    select: { sectionId: true, status: true },
  });
  const bySection = new Map<string, AttendanceStatus[]>();
  for (const m of marks) {
    const arr = bySection.get(m.sectionId) ?? [];
    arr.push(m.status);
    bySection.set(m.sectionId, arr);
  }

  const rows = sections.map((s) => {
    const statuses = bySection.get(s.id) ?? [];
    const studentCount = s._count.students;
    const markedCount = statuses.length;
    let state: 'marked' | 'partial' | 'unmarked' | 'no-teacher';
    if (!s.classTeacherId) state = 'no-teacher';
    else if (markedCount === 0) state = 'unmarked';
    else if (markedCount < studentCount) state = 'partial';
    else state = 'marked';
    return {
      sectionId: s.id,
      className: s.class.name,
      sectionName: s.name,
      classTeacher: s.classTeacher ? { id: s.classTeacher.id, fullName: s.classTeacher.user.fullName } : null,
      studentCount,
      markedCount,
      state,
      summary: summarize(statuses),
    };
  });

  return {
    date: pktDayString(date),
    sections: rows,
    unmarkedSections: rows.filter((r) => r.state === 'unmarked' || r.state === 'partial').length,
    sectionsWithoutTeacher: rows.filter((r) => r.state === 'no-teacher').length,
  };
}

export async function getSummary(dateStr?: string) {
  const date = dateStr ? parsePktDay(dateStr) : pktDay();
  const totalStudents = await prisma.student.count({ where: { status: UserStatus.ACTIVE } });
  const marks = await prisma.studentAttendance.findMany({ where: { date }, select: { status: true } });
  const summary = summarize(marks.map((m) => m.status));
  return { date: pktDayString(date), totalStudents, unmarked: totalStudents - summary.marked, ...summary };
}

export async function getTrend(days: number) {
  // The most recent PKT days that actually have marked attendance.
  const distinct = await prisma.studentAttendance.findMany({
    distinct: ['date'],
    select: { date: true },
    orderBy: { date: 'desc' },
    take: days,
  });
  const dates = distinct.map((d) => d.date).sort((a, b) => a.getTime() - b.getTime());

  const points = [];
  for (const d of dates) {
    const marks = await prisma.studentAttendance.findMany({ where: { date: d }, select: { status: true } });
    const s = summarize(marks.map((m) => m.status));
    points.push({ date: pktDayString(d), rate: s.rate, marked: s.marked });
  }
  return points;
}

// ===========================================================================
// Parent view
// ===========================================================================

async function parentProfileByUser(userId: string) {
  const profile = await prisma.parentProfile.findUnique({ where: { userId } });
  if (!profile) throw NotFound('Parent profile not found');
  return profile;
}

export async function getMyChildren(userId: string) {
  const parent = await parentProfileByUser(userId);
  const students = await prisma.student.findMany({
    where: { parentId: parent.id },
    include: { section: { include: { class: true } } },
    orderBy: { firstName: 'asc' },
  });
  return students.map((s) => ({
    id: s.id,
    name: `${s.firstName} ${s.lastName}`,
    className: s.section.class.name,
    sectionName: s.section.name,
    photoUrl: publicUrl(s.photoUrl),
    status: s.status,
  }));
}

export async function getChildAttendance(userId: string, studentId: string, year?: number, month?: number) {
  const parent = await parentProfileByUser(userId);
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    include: { section: { include: { class: true } } },
  });
  if (!student) throw NotFound('Student not found');
  if (student.parentId !== parent.id) throw Forbidden('This student is not your child');

  const now = pktDay();
  const y = year ?? now.getUTCFullYear();
  const m = month ?? now.getUTCMonth() + 1;
  const { start, endExclusive } = pktMonthRange(y, m);

  const marks = await prisma.studentAttendance.findMany({
    where: { studentId, date: { gte: start, lt: endExclusive } },
    orderBy: { date: 'asc' },
  });
  const days: Record<string, AttendanceStatus> = {};
  for (const m2 of marks) days[pktDayString(m2.date)] = m2.status;

  return {
    student: {
      id: student.id,
      name: `${student.firstName} ${student.lastName}`,
      className: student.section.class.name,
      sectionName: student.section.name,
    },
    year: y,
    month: m,
    days,
    summary: summarize(marks.map((r) => r.status)),
  };
}

export { lastNPktDays };
