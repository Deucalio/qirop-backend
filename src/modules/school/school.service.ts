import type { Prisma, School } from '@prisma/client';
import { Role } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { publicUrl, deleteFile } from '../../services/storage';
import type { UpdateSchoolInput } from './school.schema';
import { logAudit } from '../audit/audit.service';

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
    await prisma.studentDocument.deleteMany();
    const st = await prisma.student.deleteMany();
    deletedSummary['students'] = st.count;
  }

  if (categories.includes('teachers')) {
    await prisma.teacherQualification.deleteMany();
    await prisma.teacherDocument.deleteMany();
    const tp = await prisma.teacherProfile.deleteMany();
    deletedSummary['teachers'] = tp.count;
  }

  if (categories.includes('parents')) {
    const pp = await prisma.parentProfile.deleteMany();
    deletedSummary['parents'] = pp.count;
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
