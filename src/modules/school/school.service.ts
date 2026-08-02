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
