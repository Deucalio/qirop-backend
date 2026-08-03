import type { Prisma, School } from '@prisma/client';
import { Role } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { publicUrl, deleteFile } from '../../services/storage';
import type { UpdateSchoolInput } from './school.schema';
import { logAudit } from '../audit/audit.service';
import type { Actor } from '../timetable/timetable.service';

/** Convert the stored FileStore logo path into a public preview URL for the client. */
function shape(school: School) {
  return { ...school, logoUrl: publicUrl(school.logoUrl) };
}

function defaultAcademicYear(): string {
  const year = new Date().getFullYear();
  return `${year}-${year + 1}`;
}

/** The school is a single row; create a default one if the table is empty. */
async function ensureSchool() {
  const existing = await prisma.school.findFirst({ orderBy: { createdAt: 'asc' } });
  if (existing) return existing;
  return prisma.school.create({
    data: {
      name: 'Qirop School of Wisdom & Technology',
      academicYear: defaultAcademicYear(),
    },
  });
}

export async function getSchool() {
  return shape(await ensureSchool());
}

export async function updateSchool(input: UpdateSchoolInput, actorId?: string) {
  const school = await ensureSchool();
  const updated = await prisma.school.update({
    where: { id: school.id },
    data: {
      name: input.name,
      address: input.address ?? null,
      phone: input.phone ?? null,
      email: input.email ? input.email : null,
      academicYear: input.academicYear,
    },
  });

  await logAudit(null, {
    actorId: actorId ?? null,
    action: 'UPDATE',
    module: 'SCHOOL',
    targetType: 'School',
    targetId: school.id,
    targetLabel: `School Profile (${updated.name})`,
    details: `Updated school profile info & academic session (${updated.academicYear})`,
    changes: {
      name: { before: school.name, after: updated.name },
      academicYear: { before: school.academicYear, after: updated.academicYear },
    },
  });

  return shape(updated);
}

/** Set the logo to a newly-stored FileStore path, deleting the previous file. */
export async function updateLogo(newPath: string, actorId?: string) {
  const school = await ensureSchool();
  const updated = await prisma.school.update({ where: { id: school.id }, data: { logoUrl: newPath } });
  if (school.logoUrl && school.logoUrl !== newPath) {
    await deleteFile(school.logoUrl).catch(() => undefined);
  }

  await logAudit(null, {
    actorId: actorId ?? null,
    action: 'UPDATE',
    module: 'SCHOOL',
    targetType: 'School',
    targetId: school.id,
    targetLabel: `School Logo (${school.name})`,
    details: `Updated official school logo`,
  });

  return shape(updated);
}

export async function getSettings(): Promise<Record<string, unknown>> {
  const school = await ensureSchool();
  return (school.settings as Record<string, unknown> | null) ?? {};
}

export async function updateSettings(settings: Record<string, unknown>, actorId?: string) {
  const school = await ensureSchool();
  const current = (school.settings as Record<string, unknown> | null) ?? {};
  const updated = await prisma.school.update({
    where: { id: school.id },
    data: { settings: { ...current, ...settings } as Prisma.InputJsonValue },
  });

  await logAudit(null, {
    actorId: actorId ?? null,
    action: 'UPDATE',
    module: 'SCHOOL',
    targetType: 'School',
    targetId: school.id,
    targetLabel: `School Settings`,
    details: `Updated system configuration & period timing settings`,
  });

  return (updated.settings as Record<string, unknown> | null) ?? {};
}

export async function resetAllSchoolData(actor: { userId: string; role: Role | string }) {
  // 1. Transactional financial & fee data
  await prisma.feePaymentAllocation.deleteMany();
  await prisma.feePayment.deleteMany();
  await prisma.feeChallanItem.deleteMany();
  await prisma.feeChallan.deleteMany();
  await prisma.salarySlip.deleteMany();

  // 2. Operational & attendance data
  await prisma.studentAttendance.deleteMany();
  await prisma.teacherAttendance.deleteMany();
  await prisma.teacherPeriodAttendance.deleteMany();
  await prisma.homework.deleteMany();
  await prisma.expenseFunding.deleteMany();
  await prisma.expenseAttachment.deleteMany();
  await prisma.expense.deleteMany();
  await prisma.teacherQualification.deleteMany();
  await prisma.teacherDocument.deleteMany();
  await prisma.studentDocument.deleteMany();
  await prisma.timetableSlot.deleteMany();
  await prisma.teachingAssignment.deleteMany();
  await prisma.notification.deleteMany();

  // 3. Delete students
  await prisma.student.deleteMany();

  // 4. Delete profiles & non-superadmin users
  await prisma.teacherProfile.deleteMany();
  await prisma.parentProfile.deleteMany();
  await prisma.adminPermission.deleteMany({
    where: { user: { role: { not: Role.SUPERADMIN } } },
  });
  await prisma.user.deleteMany({
    where: { role: { not: Role.SUPERADMIN } },
  });

  const actorUser = await prisma.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });

  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorName: actorUser?.fullName ?? 'Super Admin',
      actorRole: actor.role as Role,
      action: 'DELETE',
      module: 'SCHOOL',
      targetType: 'SchoolData',
      targetId: 'ALL',
      targetLabel: 'Reset Entire School Database',
      details: `${actorUser?.fullName ?? 'Super Admin'} reset and permanently deleted all students, teachers, parents, fee challans, payments, and payroll records`,
    },
  });

  return { reset: true, message: 'All school data, students, teachers, parents, fee challans, and payrolls have been erased.' };
}

export async function getPurgeCounts() {
  const [
    challans,
    payments,
    salarySlips,
    studentAttendance,
    teacherAttendance,
    homework,
    expenses,
    transportRoutes,
    timetableSlots,
    notifications,
    students,
    teachers,
    parents,
    classesCount,
    sectionsCount,
    subjectsCount,
  ] = await Promise.all([
    prisma.feeChallan.count(),
    prisma.feePayment.count(),
    prisma.salarySlip.count(),
    prisma.studentAttendance.count(),
    prisma.teacherAttendance.count(),
    prisma.homework.count(),
    prisma.expense.count(),
    prisma.transportRoute.count(),
    prisma.timetableSlot.count(),
    prisma.notification.count(),
    prisma.student.count(),
    prisma.teacherProfile.count(),
    prisma.parentProfile.count(),
    prisma.class.count(),
    prisma.section.count(),
    prisma.subject.count(),
  ]);

  return {
    challans: { count: challans, label: 'Fee Challans & Payments', sub: `${challans} challans · ${payments} payments` },
    salaries: { count: salarySlips, label: 'Salary Slips & Payroll', sub: `${salarySlips} salary slips` },
    student_attendance: { count: studentAttendance, label: 'Student Attendance', sub: `${studentAttendance} attendance logs` },
    teacher_attendance: { count: teacherAttendance, label: 'Teacher Attendance', sub: `${teacherAttendance} attendance logs` },
    homework: { count: homework, label: 'Homework & Assignments', sub: `${homework} homework posts` },
    expenses: { count: expenses, label: 'Expenses & Receipts', sub: `${expenses} recorded expenses` },
    transport: { count: transportRoutes, label: 'Transport Routes & Links', sub: `${transportRoutes} active routes` },
    timetable: { count: timetableSlots, label: 'Timetable Slots', sub: `${timetableSlots} weekly periods` },
    announcements: { count: notifications, label: 'Notifications & Alerts', sub: `${notifications} system notifications` },
    students: { count: students, label: 'Student Enrolments', sub: `${students} active students` },
    teachers: { count: teachers, label: 'Teacher Profiles', sub: `${teachers} teacher accounts` },
    parents: { count: parents, label: 'Parent Accounts', sub: `${parents} parent guardians` },
    classes: { count: classesCount, label: 'Classes & Academic Structure', sub: `${classesCount} classes · ${sectionsCount} sections · ${subjectsCount} subjects` },
  };
}

export async function purgeBatchData(actor: { userId: string; role: Role | string }, categories: string[]) {
  const deletedSummary: Record<string, number> = {};

  if (categories.includes('challans')) {
    await prisma.feePaymentAllocation.deleteMany();
    const p = await prisma.feePayment.deleteMany();
    await prisma.feeChallanItem.deleteMany();
    const c = await prisma.feeChallan.deleteMany();
    deletedSummary['challans'] = c.count;
    deletedSummary['payments'] = p.count;
  }

  if (categories.includes('salaries')) {
    const s = await prisma.salarySlip.deleteMany();
    deletedSummary['salaries'] = s.count;
  }

  if (categories.includes('student_attendance')) {
    const sa = await prisma.studentAttendance.deleteMany();
    deletedSummary['student_attendance'] = sa.count;
  }

  if (categories.includes('teacher_attendance')) {
    const ta = await prisma.teacherAttendance.deleteMany();
    await prisma.teacherPeriodAttendance.deleteMany();
    deletedSummary['teacher_attendance'] = ta.count;
  }

  if (categories.includes('homework')) {
    const h = await prisma.homework.deleteMany();
    deletedSummary['homework'] = h.count;
  }

  if (categories.includes('expenses')) {
    await prisma.expenseFunding.deleteMany();
    await prisma.expenseAttachment.deleteMany();
    const e = await prisma.expense.deleteMany();
    deletedSummary['expenses'] = e.count;
  }

  if (categories.includes('transport')) {
    await prisma.transportAssignment.deleteMany();
    const tr = await prisma.transportRoute.deleteMany();
    deletedSummary['transport'] = tr.count;
  }

  if (categories.includes('timetable')) {
    const ts = await prisma.timetableSlot.deleteMany();
    await prisma.teachingAssignment.deleteMany();
    deletedSummary['timetable'] = ts.count;
  }

  if (categories.includes('announcements')) {
    const n = await prisma.notification.deleteMany();
    deletedSummary['announcements'] = n.count;
  }

  if (categories.includes('students')) {
    const allSts = await prisma.student.findMany({ select: { id: true } });
    deletedSummary['students'] = await purgeStudentsBatch(actor, allSts.map((s) => s.id));
  }

  if (categories.includes('teachers')) {
    const allTps = await prisma.teacherProfile.findMany({ select: { id: true } });
    deletedSummary['teachers'] = await purgeTeachersBatch(actor, allTps.map((t) => t.id));
  }

  if (categories.includes('parents')) {
    const allPps = await prisma.parentProfile.findMany({ select: { id: true } });
    deletedSummary['parents'] = await purgeParentsBatch(actor, allPps.map((p) => p.id));
  }

  if (categories.includes('classes')) {
    const allClasses = await prisma.class.findMany({ select: { id: true } });
    deletedSummary['classes'] = await purgeClassesBatch(actor, allClasses.map((c) => c.id));
    await prisma.subject.deleteMany();
  }

  const actorUser = await prisma.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });

  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorName: actorUser?.fullName ?? 'Admin',
      actorRole: actor.role as Role,
      action: 'DELETE',
      module: 'SCHOOL',
      targetType: 'SelectivePurge',
      targetId: categories.join(','),
      targetLabel: `Batch Purge (${categories.length} modules)`,
      details: `${actorUser?.fullName ?? 'Admin'} selectively purged ${categories.length} data modules: ${categories.join(', ')}`,
      changes: deletedSummary,
    },
  });

  return { purged: deletedSummary, message: `Successfully purged ${categories.length} selected module(s)` };
}

function fmtDt(d: Date | null | undefined): { dateStr: string; timeStr: string } {
  if (!d) return { dateStr: 'N/A', timeStr: 'N/A' };
  const dateObj = new Date(d);
  return {
    dateStr: dateObj.toLocaleDateString('en-PK', { day: '2-digit', month: 'short', year: 'numeric' }),
    timeStr: dateObj.toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }),
  };
}

export async function getPurgeDetailedItems() {
  const [
    rawChallans,
    rawSalaries,
    rawStudentAttendance,
    rawTeacherAttendance,
    rawHomework,
    rawExpenses,
    rawTransport,
    rawTimetable,
    rawNotifications,
    rawStudents,
    rawTeachers,
    rawParents,
    rawClasses,
  ] = await Promise.all([
    prisma.feeChallan.findMany({
      include: { student: { select: { firstName: true, lastName: true, admissionNo: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.salarySlip.findMany({
      include: { teacher: { include: { user: { select: { fullName: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.studentAttendance.findMany({
      include: { student: { select: { firstName: true, lastName: true } }, section: { include: { class: true } } },
      orderBy: { date: 'desc' },
      take: 200,
    }),
    prisma.teacherAttendance.findMany({
      include: { teacher: { include: { user: { select: { fullName: true } } } } },
      orderBy: { date: 'desc' },
      take: 200,
    }),
    prisma.homework.findMany({
      include: { section: { include: { class: true } }, subject: true, teacher: { include: { user: { select: { fullName: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.expense.findMany({
      orderBy: { date: 'desc' },
      take: 200,
    }),
    prisma.transportRoute.findMany({
      include: { _count: { select: { assignments: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.timetableSlot.findMany({
      include: { section: { include: { class: true } }, subject: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.notification.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.student.findMany({
      include: { section: { include: { class: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.teacherProfile.findMany({
      include: { user: { select: { fullName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.parentProfile.findMany({
      include: { user: { select: { fullName: true, phone: true } }, students: { select: { firstName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.class.findMany({
      include: { sections: true, classSubjects: { include: { subject: true } } },
      orderBy: { order: 'asc' },
    }),
  ]);

  return {
    challans: rawChallans.map((c) => {
      const dt = fmtDt(c.createdAt);
      return {
        id: c.id,
        title: `Challan #${c.challanNo}`,
        subtitle: `${c.student.firstName} ${c.student.lastName} (${c.student.admissionNo}) · Month ${c.month}/${c.year}`,
        amount: `Rs ${Number(c.amount).toLocaleString()}`,
        status: c.status,
        dateStr: dt.dateStr,
        timeStr: dt.timeStr,
      };
    }),

    salaries: rawSalaries.map((s) => {
      const dt = fmtDt(s.createdAt);
      return {
        id: s.id,
        title: `Salary Slip ${s.year}-${String(s.month).padStart(2, '0')}`,
        subtitle: `${s.teacher.user.fullName} · Status: ${s.status}`,
        amount: `Rs ${Number(s.netSalary).toLocaleString()}`,
        status: s.status,
        dateStr: dt.dateStr,
        timeStr: dt.timeStr,
      };
    }),

    student_attendance: rawStudentAttendance.map((sa) => {
      const dt = fmtDt(sa.createdAt);
      return {
        id: sa.id,
        title: `${sa.student.firstName} ${sa.student.lastName} — ${sa.status}`,
        subtitle: `${sa.section.class.name}-${sa.section.name}`,
        dateStr: fmtDt(sa.date).dateStr,
        timeStr: dt.timeStr,
      };
    }),

    teacher_attendance: rawTeacherAttendance.map((ta) => {
      const dt = fmtDt(ta.date);
      return {
        id: ta.id,
        title: `${ta.teacher.user.fullName} — ${ta.status}`,
        subtitle: ta.checkInTime ? `Check-in: ${new Date(ta.checkInTime).toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' })}` : 'No Check-in',
        dateStr: dt.dateStr,
        timeStr: dt.timeStr,
      };
    }),

    homework: rawHomework.map((h) => {
      const dt = fmtDt(h.createdAt);
      return {
        id: h.id,
        title: h.title,
        subtitle: `${h.section.class.name}-${h.section.name} · ${h.subject.name} · By: ${h.teacher.user.fullName}`,
        dateStr: dt.dateStr,
        timeStr: dt.timeStr,
      };
    }),

    expenses: rawExpenses.map((e) => {
      const dt = fmtDt(e.createdAt);
      return {
        id: e.id,
        title: e.title,
        subtitle: `Category: ${e.category}`,
        amount: `Rs ${Number(e.amount).toLocaleString()}`,
        dateStr: dt.dateStr,
        timeStr: dt.timeStr,
      };
    }),

    transport: rawTransport.map((tr) => {
      const dt = fmtDt(tr.createdAt);
      return {
        id: tr.id,
        title: tr.name,
        subtitle: `${tr._count.assignments} assigned rider(s) · ${tr.vehicleInfo || 'No vehicle info'}`,
        amount: `Rs ${Number(tr.monthlyFee).toLocaleString()}`,
        dateStr: dt.dateStr,
        timeStr: dt.timeStr,
      };
    }),

    timetable: rawTimetable.map((tt) => {
      const dt = fmtDt(tt.createdAt);
      return {
        id: tt.id,
        title: `${tt.section.class.name}-${tt.section.name} · Period ${tt.periodIndex} (${tt.day})`,
        subtitle: `${tt.subject.name}`,
        dateStr: dt.dateStr,
        timeStr: dt.timeStr,
      };
    }),

    announcements: rawNotifications.map((n) => {
      const dt = fmtDt(n.createdAt);
      return {
        id: n.id,
        title: n.title,
        subtitle: n.body,
        dateStr: dt.dateStr,
        timeStr: dt.timeStr,
      };
    }),

    students: rawStudents.map((st) => {
      const dt = fmtDt(st.createdAt);
      return {
        id: st.id,
        title: `${st.firstName} ${st.lastName}`,
        subtitle: `Adm #${st.admissionNo} · Roll #${st.rollNo || 'N/A'} · ${st.section.class.name}-${st.section.name}`,
        dateStr: dt.dateStr,
        timeStr: dt.timeStr,
      };
    }),

    teachers: rawTeachers.map((tp) => {
      const dt = fmtDt(tp.createdAt);
      return {
        id: tp.id,
        title: tp.user.fullName,
        subtitle: `Emp ID: ${tp.employeeId} · Gender: ${tp.gender}`,
        dateStr: dt.dateStr,
        timeStr: dt.timeStr,
      };
    }),

    parents: rawParents.map((pp) => {
      const dt = fmtDt(pp.createdAt);
      return {
        id: pp.id,
        title: pp.user.fullName,
        subtitle: `Phone: ${pp.user.phone || 'N/A'} · Children: ${pp.students.map((s) => s.firstName).join(', ') || 'None'}`,
        dateStr: dt.dateStr,
        timeStr: dt.timeStr,
      };
    }),

    classes: rawClasses.map((c) => {
      const dt = fmtDt(c.createdAt);
      return {
        id: c.id,
        title: c.name,
        subtitle: `${c.sections.length} section(s) (${c.sections.map((s) => s.name).join(', ') || 'None'}) · ${c.classSubjects.length} subject(s)`,
        dateStr: dt.dateStr,
        timeStr: dt.timeStr,
      };
    }),
  };
}

export async function purgeSelectiveItemsMap(
  actor: { userId: string; role: Role | string },
  itemMap: Record<string, string[]>,
) {
  const deletedCounts: Record<string, number> = {};
  const tasks: Promise<unknown>[] = [];

  if (itemMap.challans?.length) {
    const ids = itemMap.challans;
    tasks.push(
      prisma.$transaction([
        prisma.feePaymentAllocation.deleteMany({ where: { challanId: { in: ids } } }),
        prisma.feeChallanItem.deleteMany({ where: { challanId: { in: ids } } }),
        prisma.feeChallan.deleteMany({ where: { id: { in: ids } } }),
      ]).then(([, , c]) => { deletedCounts['challans'] = c.count; })
    );
  }

  if (itemMap.salaries?.length) {
    const ids = itemMap.salaries;
    tasks.push(
      prisma.salarySlip.deleteMany({ where: { id: { in: ids } } })
        .then((s) => { deletedCounts['salaries'] = s.count; })
    );
  }

  if (itemMap.student_attendance?.length) {
    const ids = itemMap.student_attendance;
    tasks.push(
      prisma.studentAttendance.deleteMany({ where: { id: { in: ids } } })
        .then((sa) => { deletedCounts['student_attendance'] = sa.count; })
    );
  }

  if (itemMap.teacher_attendance?.length) {
    const ids = itemMap.teacher_attendance;
    tasks.push(
      prisma.teacherAttendance.deleteMany({ where: { id: { in: ids } } })
        .then((ta) => { deletedCounts['teacher_attendance'] = ta.count; })
    );
  }

  if (itemMap.homework?.length) {
    const ids = itemMap.homework;
    tasks.push(
      prisma.homework.deleteMany({ where: { id: { in: ids } } })
        .then((h) => { deletedCounts['homework'] = h.count; })
    );
  }

  if (itemMap.expenses?.length) {
    const ids = itemMap.expenses;
    tasks.push(
      prisma.$transaction([
        prisma.expenseFunding.deleteMany({ where: { expenseId: { in: ids } } }),
        prisma.expenseAttachment.deleteMany({ where: { expenseId: { in: ids } } }),
        prisma.expense.deleteMany({ where: { id: { in: ids } } }),
      ]).then(([, , e]) => { deletedCounts['expenses'] = e.count; })
    );
  }

  if (itemMap.transport?.length) {
    const ids = itemMap.transport;
    tasks.push(
      prisma.$transaction([
        prisma.transportAssignment.deleteMany({ where: { routeId: { in: ids } } }),
        prisma.transportRoute.deleteMany({ where: { id: { in: ids } } }),
      ]).then(([, tr]) => { deletedCounts['transport'] = tr.count; })
    );
  }

  if (itemMap.timetable?.length) {
    const ids = itemMap.timetable;
    tasks.push(
      prisma.timetableSlot.deleteMany({ where: { id: { in: ids } } })
        .then((tt) => { deletedCounts['timetable'] = tt.count; })
    );
  }

  if (itemMap.announcements?.length) {
    const ids = itemMap.announcements;
    tasks.push(
      prisma.notification.deleteMany({ where: { id: { in: ids } } })
        .then((n) => { deletedCounts['announcements'] = n.count; })
    );
  }

  if (itemMap.students?.length) {
    deletedCounts['students'] = await purgeStudentsBatch(actor, itemMap.students);
  }

  if (itemMap.teachers?.length) {
    deletedCounts['teachers'] = await purgeTeachersBatch(actor, itemMap.teachers);
  }

  if (itemMap.parents?.length) {
    deletedCounts['parents'] = await purgeParentsBatch(actor, itemMap.parents);
  }

  if (itemMap.classes?.length) {
    deletedCounts['classes'] = await purgeClassesBatch(actor, itemMap.classes);
  }

  await Promise.all(tasks);

  const totalItems = Object.values(deletedCounts).reduce((a, b) => a + b, 0);
  const actorUser = await prisma.user.findUnique({ where: { id: actor.userId }, select: { fullName: true } });

  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorName: actorUser?.fullName ?? 'Admin',
      actorRole: actor.role as Role,
      action: 'DELETE',
      module: 'SCHOOL',
      targetType: 'ItemSelectivePurge',
      targetId: 'ITEM_BATCH',
      targetLabel: `Purged ${totalItems} selected items`,
      details: `${actorUser?.fullName ?? 'Admin'} deleted ${totalItems} specific items across ${Object.keys(deletedCounts).length} modules`,
      changes: deletedCounts,
    },
  });

  return { purged: deletedCounts, message: `Successfully deleted ${totalItems} selected item(s)` };
}

export async function purgeTeachersBatch(actor: { userId: string; role: Role | string }, ids: string[]): Promise<number> {
  if (!ids || !ids.length) return 0;

  const tProfiles = await prisma.teacherProfile.findMany({
    where: { id: { in: ids } },
    select: { id: true, userId: true },
  });
  const tIds = tProfiles.map((tp) => tp.id);
  const uIds = tProfiles.map((tp) => tp.userId).filter(Boolean);

  if (!tIds.length) return 0;

  // 1. Re-attribute actor references to acting admin so user deletion succeeds
  await prisma.studentAttendance.updateMany({ where: { markedById: { in: uIds } }, data: { markedById: actor.userId } });
  await prisma.teacherPeriodAttendance.updateMany({ where: { markedById: { in: uIds } }, data: { markedById: actor.userId } });
  await prisma.feePayment.updateMany({ where: { receivedById: { in: uIds } }, data: { receivedById: actor.userId } });
  await prisma.salarySlip.updateMany({ where: { generatedById: { in: uIds } }, data: { generatedById: actor.userId } });
  await prisma.expense.updateMany({ where: { recordedById: { in: uIds } }, data: { recordedById: actor.userId } });

  // 2. Drop optional links pointing to these teachers
  await prisma.section.updateMany({ where: { classTeacherId: { in: tIds } }, data: { classTeacherId: null } });
  await prisma.student.updateMany({ where: { teacherParentId: { in: tIds } }, data: { teacherParentId: null } });
  await prisma.feeChallan.updateMany({ where: { billedToTeacherId: { in: tIds } }, data: { billedToTeacherId: null } });

  // 3. Delete dependent rows owned by teachers
  await prisma.homework.deleteMany({ where: { teacherId: { in: tIds } } });
  await prisma.teachingAssignment.deleteMany({ where: { teacherId: { in: tIds } } });
  await prisma.teacherAttendance.deleteMany({ where: { teacherId: { in: tIds } } });
  await prisma.teacherPeriodAttendance.deleteMany({ where: { teacherId: { in: tIds } } });
  await prisma.salarySlip.deleteMany({ where: { teacherId: { in: tIds } } });
  await prisma.teacherQualification.deleteMany({ where: { teacherId: { in: tIds } } });
  await prisma.teacherDocument.deleteMany({ where: { teacherId: { in: tIds } } });
  await prisma.transportAssignment.deleteMany({ where: { teacherId: { in: tIds } } });

  // 4. Delete teacher profiles
  const res = await prisma.teacherProfile.deleteMany({ where: { id: { in: tIds } } });

  // 5. Delete corresponding login Users
  if (uIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: uIds } } });
  }

  return res.count;
}

export async function purgeStudentsBatch(actor: { userId: string; role: Role | string }, ids: string[]): Promise<number> {
  if (!ids || !ids.length) return 0;

  // Delete dependent rows for students
  await prisma.feePayment.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.feeChallan.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.studentAttendance.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.studentDocument.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.transportAssignment.deleteMany({ where: { studentId: { in: ids } } });

  const res = await prisma.student.deleteMany({ where: { id: { in: ids } } });
  return res.count;
}

export async function purgeParentsBatch(actor: { userId: string; role: Role | string }, ids: string[]): Promise<number> {
  if (!ids || !ids.length) return 0;

  const pProfiles = await prisma.parentProfile.findMany({
    where: { id: { in: ids } },
    select: { id: true, userId: true },
  });
  const pIds = pProfiles.map((p) => p.id);
  const uIds = pProfiles.map((p) => p.userId).filter(Boolean);

  if (!pIds.length) return 0;

  const res = await prisma.parentProfile.deleteMany({ where: { id: { in: pIds } } });
  if (uIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: uIds } } });
  }

  return res.count;
}

export async function purgeClassesBatch(actor: { userId: string; role: Role | string }, ids: string[]): Promise<number> {
  if (!ids || !ids.length) return 0;

  const sections = await prisma.section.findMany({
    where: { classId: { in: ids } },
    select: { id: true },
  });
  const sectionIds = sections.map((s) => s.id);

  if (sectionIds.length) {
    await prisma.studentAttendance.deleteMany({ where: { sectionId: { in: sectionIds } } });
    await prisma.teacherPeriodAttendance.deleteMany({ where: { sectionId: { in: sectionIds } } });
    await prisma.homework.deleteMany({ where: { sectionId: { in: sectionIds } } });
    await prisma.timetableSlot.deleteMany({ where: { sectionId: { in: sectionIds } } });
    await prisma.teachingAssignment.deleteMany({ where: { sectionId: { in: sectionIds } } });

    await prisma.feePayment.deleteMany({ where: { student: { sectionId: { in: sectionIds } } } });
    await prisma.feeChallan.deleteMany({ where: { student: { sectionId: { in: sectionIds } } } });
    await prisma.studentDocument.deleteMany({ where: { student: { sectionId: { in: sectionIds } } } });
    await prisma.transportAssignment.deleteMany({ where: { student: { sectionId: { in: sectionIds } } } });
    await prisma.student.deleteMany({ where: { sectionId: { in: sectionIds } } });
  }

  await prisma.classSubject.deleteMany({ where: { classId: { in: ids } } });
  await prisma.feeStructure.deleteMany({ where: { classId: { in: ids } } });
  await prisma.section.deleteMany({ where: { classId: { in: ids } } });

  const res = await prisma.class.deleteMany({ where: { id: { in: ids } } });
  return res.count;
}
