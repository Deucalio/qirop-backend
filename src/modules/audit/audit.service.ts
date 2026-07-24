import type { Request } from 'express';
import { prisma } from '../../config/prisma';
import type { Role } from '@prisma/client';

export interface AuditLogParams {
  action: string;      // CREATE, UPDATE, DELETE, ATTENDANCE, PAYMENT, DISCOUNT, REVERSAL, RESET, LOGIN
  module: string;      // STUDENTS, STAFF, ATTENDANCE, TIMETABLE, FEES, SALARIES, EXPENSES, USERS, SCHOOL
  targetType: string;  // Student, Teacher, ClassSection, FeeChallan, SalarySlip, Expense, User, SchoolSetting
  targetId?: string | null;
  targetLabel: string;
  details: string;
  changes?: Record<string, { before: unknown; after: unknown }> | null;
  actorId?: string | null;
  actorName?: string;
  actorRole?: Role;
}

/**
 * Log an audit micro-action to the database.
 */
export async function logAudit(req: Request | null, params: AuditLogParams) {
  try {
    let actorId = params.actorId ?? req?.user?.userId ?? null;
    let actorName = params.actorName ?? 'System Admin';
    let actorRole: Role = params.actorRole ?? req?.user?.role ?? 'ADMIN';

    if (actorId && !params.actorName) {
      const u = await prisma.user.findUnique({ where: { id: actorId }, select: { fullName: true, role: true } });
      if (u) {
        actorName = u.fullName;
        actorRole = u.role;
      }
    }

    const ipAddress = req ? (req.headers['x-forwarded-for'] as string) || req.socket?.remoteAddress || null : null;
    const userAgent = req ? (req.headers['user-agent'] as string) || null : null;

    return await prisma.auditLog.create({
      data: {
        actorId,
        actorName,
        actorRole,
        action: params.action,
        module: params.module,
        targetType: params.targetType,
        targetId: params.targetId ?? null,
        targetLabel: params.targetLabel,
        details: params.details,
        changes: params.changes ? (params.changes as any) : undefined,
        ipAddress,
        userAgent,
      },
    });
  } catch (err) {
    console.error('Failed to write audit log:', err);
    return null;
  }
}

/**
 * List audit logs with pagination and filters.
 */
export async function listAuditLogs(params: {
  module?: string;
  action?: string;
  actorRole?: string;
  actorId?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
  page?: number;
  limit?: number;
}) {
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(100, Math.max(1, params.limit ?? 30));
  const skip = (page - 1) * limit;

  const where: any = {};

  if (params.module && params.module !== 'all') {
    where.module = params.module;
  }

  if (params.action && params.action !== 'all') {
    where.action = params.action;
  }

  if (params.actorRole && params.actorRole !== 'all') {
    where.actorRole = params.actorRole as Role;
  }

  if (params.actorId) {
    where.actorId = params.actorId;
  }

  if (params.startDate || params.endDate) {
    where.timestamp = {};
    if (params.startDate) {
      where.timestamp.gte = new Date(params.startDate);
    }
    if (params.endDate) {
      const end = new Date(params.endDate);
      end.setHours(23, 59, 59, 999);
      where.timestamp.lte = end;
    }
  }

  if (params.search && params.search.trim()) {
    const q = params.search.trim();
    where.OR = [
      { actorName: { contains: q, mode: 'insensitive' } },
      { targetLabel: { contains: q, mode: 'insensitive' } },
      { details: { contains: q, mode: 'insensitive' } },
      { module: { contains: q, mode: 'insensitive' } },
      { action: { contains: q, mode: 'insensitive' } },
    ];
  }

  const [total, items] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      skip,
      take: limit,
    }),
  ]);

  return {
    items,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * Seed historical audit logs for initial demo.
 */
export async function seedAuditLogsIfEmpty(force = false) {
  const stubCount = await prisma.auditLog.count({
    where: { details: 'Action recorded in system history' },
  });

  if (force || stubCount > 0) {
    // Delete legacy placeholder rows
    await prisma.auditLog.deleteMany({
      where: { details: 'Action recorded in system history' },
    });
  }

  const count = await prisma.auditLog.count();
  if (!force && count >= 10) return;

  const now = new Date();
  const daysAgo = (d: number, hours = 10, mins = 30) => {
    const date = new Date(now);
    date.setDate(date.getDate() - d);
    date.setHours(hours, mins, 0, 0);
    return date;
  };

  const seedData = [
    {
      timestamp: daysAgo(0, 9, 15),
      actorName: 'Ayesha Khan',
      actorRole: 'TEACHER' as Role,
      action: 'ATTENDANCE',
      module: 'ATTENDANCE',
      targetType: 'ClassSection',
      targetLabel: 'Class 5-A Roster',
      details: 'Ayesha Khan marked daily attendance for Class 5-A (24 Present, 2 Absent, 1 Leave)',
      changes: null,
      ipAddress: '192.168.1.45',
      userAgent: 'Chrome 126.0 (Windows 11)',
    },
    {
      timestamp: daysAgo(0, 8, 45),
      actorName: 'School Owner',
      actorRole: 'SUPERADMIN' as Role,
      action: 'DISCOUNT',
      module: 'FEES',
      targetType: 'FeeChallan',
      targetLabel: 'Challan #CH-2026-07-104 (Ali Ahmed)',
      details: "Admin updated Ali Ahmed's July 2026 Fee Challan: applied Rs. 500 Merit Scholarship Discount",
      changes: {
        discountAmount: { before: '0.00', after: '500.00' },
        payableAmount: { before: '4500.00', after: '4000.00' },
      },
      ipAddress: '192.168.1.10',
      userAgent: 'Chrome 126.0 (Windows 11)',
    },
    {
      timestamp: daysAgo(1, 14, 20),
      actorName: 'School Owner',
      actorRole: 'SUPERADMIN' as Role,
      action: 'UPDATE',
      module: 'STUDENTS',
      targetType: 'Student',
      targetLabel: 'Fatima Noor (STD-102)',
      details: "Admin updated Fatima Noor's parent contact phone number from 0300-1234567 to 0311-9876543",
      changes: {
        parentPhone: { before: '0300-1234567', after: '0311-9876543' },
      },
      ipAddress: '192.168.1.10',
      userAgent: 'Chrome 126.0 (Windows 11)',
    },
    {
      timestamp: daysAgo(1, 11, 0),
      actorName: 'School Owner',
      actorRole: 'SUPERADMIN' as Role,
      action: 'PAYMENT',
      module: 'FEES',
      targetType: 'FeePayment',
      targetLabel: 'Receipt #REC-8842 (Hassan Raza)',
      details: 'Recorded Rs. 5,000 cash payment for Hassan Raza (Challan #CH-2026-07-102)',
      changes: {
        paidAmount: { before: '0.00', after: '5000.00' },
        status: { before: 'UNPAID', after: 'PAID' },
      },
      ipAddress: '192.168.1.10',
      userAgent: 'Chrome 126.0 (Windows 11)',
    },
    {
      timestamp: daysAgo(2, 16, 10),
      actorName: 'School Owner',
      actorRole: 'SUPERADMIN' as Role,
      action: 'UPDATE',
      module: 'TIMETABLE',
      targetType: 'ClassSection',
      targetLabel: 'Class 5-B Timetable',
      details: 'Reassigned Period 3 Mathematics teacher for Class 5-B from Bilal Ahmed to Ayesha Khan',
      changes: {
        teacherName: { before: 'Bilal Ahmed', after: 'Ayesha Khan' },
      },
      ipAddress: '192.168.1.10',
      userAgent: 'Chrome 126.0 (Windows 11)',
    },
    {
      timestamp: daysAgo(2, 12, 30),
      actorName: 'School Owner',
      actorRole: 'SUPERADMIN' as Role,
      action: 'UPDATE',
      module: 'STAFF',
      targetType: 'Teacher',
      targetLabel: 'Zubair Shah (EMP-104)',
      details: "Admin updated Zubair Shah's educational qualification and base salary",
      changes: {
        qualification: { before: 'B.Sc Physics', after: 'M.Sc Physics' },
        baseSalary: { before: '45000.00', after: '55000.00' },
      },
      ipAddress: '192.168.1.10',
      userAgent: 'Chrome 126.0 (Windows 11)',
    },
    {
      timestamp: daysAgo(3, 10, 0),
      actorName: 'School Owner',
      actorRole: 'SUPERADMIN' as Role,
      action: 'CREATE',
      module: 'FEES',
      targetType: 'FeeChallan',
      targetLabel: 'Monthly Fee Challans (July 2026)',
      details: 'Batch generated 485 monthly fee challans for July 2026 academic term',
      changes: null,
      ipAddress: '192.168.1.10',
      userAgent: 'Chrome 126.0 (Windows 11)',
    },
    {
      timestamp: daysAgo(3, 9, 30),
      actorName: 'Tariq Mehmood',
      actorRole: 'TEACHER' as Role,
      action: 'ATTENDANCE',
      module: 'ATTENDANCE',
      targetType: 'TeacherProfile',
      targetLabel: 'Self Check-In',
      details: 'Tariq Mehmood recorded self check-in at 09:30 AM',
      changes: null,
      ipAddress: '192.168.1.52',
      userAgent: 'Chrome 126.0 (Windows 11)',
    },
    {
      timestamp: daysAgo(4, 15, 45),
      actorName: 'School Owner',
      actorRole: 'SUPERADMIN' as Role,
      action: 'RESET',
      module: 'USERS',
      targetType: 'User',
      targetLabel: 'User: ayesha.khan@qirop.edu.pk',
      details: 'Admin reset password for user Ayesha Khan and issued temporary credentials',
      changes: null,
      ipAddress: '192.168.1.10',
      userAgent: 'Chrome 126.0 (Windows 11)',
    },
    {
      timestamp: daysAgo(5, 11, 15),
      actorName: 'School Owner',
      actorRole: 'SUPERADMIN' as Role,
      action: 'CREATE',
      module: 'EXPENSES',
      targetType: 'Expense',
      targetLabel: 'Voucher #EXP-401 (Lab Chemicals)',
      details: 'Recorded Rs. 14,500 expense for Science Lab Equipment & Chemicals via School Cash',
      changes: null,
      ipAddress: '192.168.1.10',
      userAgent: 'Chrome 126.0 (Windows 11)',
    },
    {
      timestamp: daysAgo(6, 14, 0),
      actorName: 'School Owner',
      actorRole: 'SUPERADMIN' as Role,
      action: 'UPDATE',
      module: 'SCHOOL',
      targetType: 'SchoolSetting',
      targetLabel: 'School General Settings',
      details: 'Updated official school contact phone number from 021-34567890 to 021-39988776',
      changes: {
        contactPhone: { before: '021-34567890', after: '021-39988776' },
      },
      ipAddress: '192.168.1.10',
      userAgent: 'Chrome 126.0 (Windows 11)',
    },
    {
      timestamp: daysAgo(7, 10, 30),
      actorName: 'School Owner',
      actorRole: 'SUPERADMIN' as Role,
      action: 'CREATE',
      module: 'STUDENTS',
      targetType: 'Student',
      targetLabel: 'Bilal Hassan (STD-109)',
      details: 'Admitted new student Bilal Hassan to Class 1-A (Parent: Hassan Raza)',
      changes: null,
      ipAddress: '192.168.1.10',
      userAgent: 'Chrome 126.0 (Windows 11)',
    },
  ];

  for (const item of seedData) {
    await prisma.auditLog.create({
      data: {
        timestamp: item.timestamp,
        actorName: item.actorName,
        actorRole: item.actorRole,
        action: item.action,
        module: item.module,
        targetType: item.targetType,
        targetLabel: item.targetLabel,
        details: item.details,
        changes: item.changes ? (item.changes as any) : undefined,
        ipAddress: item.ipAddress,
        userAgent: item.userAgent,
      },
    });
  }
}
