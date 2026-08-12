import { Prisma, Role } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError, NotFound } from '../../utils/apiResponse';
import { toMoneyString, sum, money } from '../../utils/money';
import type { CreateRouteInput, UpdateRouteInput, AssignInput, UnassignInput } from './transport.schema';

export interface Actor {
  userId: string;
  role: Role;
}

/**
 * The only keys `audit` reads. Typed rather than a loose record so the compiler
 * rejects anything else: this helper silently discards unknown keys, and a
 * caller that passes its figures at the top level gets an audit entry with no
 * figures in it and no error to say so.
 */
interface RouteAuditMeta {
  name?: string;
  details?: string;
  changes?: Record<string, unknown>;
}

async function audit(userId: string, action: string, entityId: string, metadata: RouteAuditMeta) {
  try {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { fullName: true, role: true } });
    await prisma.auditLog.create({
      data: {
        actorId: userId,
        actorName: u?.fullName ?? 'Admin',
        actorRole: u?.role ?? 'ADMIN',
        action,
        module: 'FEES',
        targetType: 'TransportRoute',
        targetId: entityId,
        targetLabel: (metadata.name as string) || `Transport Route #${entityId.slice(0, 8)}`,
        details: (metadata.details as string) || `Transport route action ${action}`,
        changes: metadata.changes ? (metadata.changes as any) : undefined,
      },
    });
  } catch {
    /* audit is best-effort */
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function listRoutes() {
  const routes = await prisma.transportRoute.findMany({
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
    include: {
      assignments: { select: { studentId: true, teacherId: true } },
    },
  });
  return routes.map((r) => {
    const studentRiders = r.assignments.filter((a) => a.studentId).length;
    const teacherRiders = r.assignments.filter((a) => a.teacherId).length;
    const riders = studentRiders + teacherRiders;
    return {
      id: r.id,
      name: r.name,
      studentMonthlyFee: r.studentMonthlyFee === null ? null : toMoneyString(r.studentMonthlyFee),
      staffMonthlyFee: r.staffMonthlyFee === null ? null : toMoneyString(r.staffMonthlyFee),
      /** Null means the route does not carry that kind of rider at all. */
      carriesStudents: r.studentMonthlyFee !== null,
      carriesStaff: r.staffMonthlyFee !== null,
      vehicleInfo: r.vehicleInfo,
      driverName: r.driverName,
      driverPhone: r.driverPhone,
      stops: r.stops,
      active: r.active,
      studentRiders,
      teacherRiders,
      riders,
      // Each rider type at its own rate — one fee times a head count would be
      // wrong the moment the two rates differ.
      monthlyTotal: toMoneyString(
        money(r.studentMonthlyFee ?? 0).times(studentRiders).plus(money(r.staffMonthlyFee ?? 0).times(teacherRiders)),
      ),
    };
  });
}

export async function getRoute(id: string) {
  const r = await prisma.transportRoute.findUnique({
    where: { id },
    include: {
      assignments: {
        include: {
          student: { include: { section: { include: { class: true } }, parent: { include: { user: true } } } },
          teacher: { include: { user: true } },
        },
      },
    },
  });
  if (!r) throw NotFound('Route not found');

  const students = r.assignments
    .filter((a) => a.student)
    .map((a) => ({
      assignmentId: a.id,
      id: a.student!.id,
      name: `${a.student!.firstName} ${a.student!.lastName}`,
      admissionNo: a.student!.admissionNo,
      className: a.student!.section.class.name,
      sectionName: a.student!.section.name,
      parentName: a.student!.parent.user.fullName,
      parentPhone: a.student!.parent.user.phone,
      parentCnic: a.student!.parent.user.cnic,
      bFormNo: a.student!.bFormNo,
      isStaffChild: !!a.student!.teacherParentId,
    }));
  const teachers = r.assignments
    .filter((a) => a.teacher)
    .map((a) => ({
      assignmentId: a.id,
      id: a.teacher!.id,
      name: a.teacher!.user.fullName,
      employeeId: a.teacher!.employeeId,
      phone: a.teacher!.user.phone,
      cnic: a.teacher!.user.cnic,
      staffRole: a.teacher!.staffRole,
    }));

  return {
    id: r.id,
    name: r.name,
    studentMonthlyFee: r.studentMonthlyFee === null ? null : toMoneyString(r.studentMonthlyFee),
    staffMonthlyFee: r.staffMonthlyFee === null ? null : toMoneyString(r.staffMonthlyFee),
    carriesStudents: r.studentMonthlyFee !== null,
    carriesStaff: r.staffMonthlyFee !== null,
    vehicleInfo: r.vehicleInfo,
    driverName: r.driverName,
    driverPhone: r.driverPhone,
    stops: r.stops,
    active: r.active,
    students,
    teachers,
    monthlyTotal: toMoneyString(
      money(r.studentMonthlyFee ?? 0).times(students.length).plus(money(r.staffMonthlyFee ?? 0).times(teachers.length)),
    ),
  };
}

export async function createRoute(actor: Actor, input: CreateRouteInput) {
  const r = await prisma.transportRoute.create({
    data: {
      name: input.name,
      studentMonthlyFee: input.studentMonthlyFee ?? null,
      staffMonthlyFee: input.staffMonthlyFee ?? null,
      vehicleInfo: input.vehicleInfo ?? null,
      driverName: input.driverName ?? null,
      driverPhone: input.driverPhone ?? null,
      stops: input.stops ?? null,
      active: input.active ?? true,
    },
  });
  await audit(actor.userId, 'TRANSPORT_ROUTE_CREATED', r.id, {
    name: r.name,
    details:
      `Created transport route "${r.name}" — students ${rateLabel(r.studentMonthlyFee)}, staff ${rateLabel(r.staffMonthlyFee)}.`,
    changes: {
      studentMonthlyFee: { before: null, after: rateLabel(r.studentMonthlyFee) },
      staffMonthlyFee: { before: null, after: rateLabel(r.staffMonthlyFee) },
    },
  });
  return getRoute(r.id);
}

/**
 * Assert a route carries this kind of rider, throwing if it does not.
 *
 * Exported because transport is assigned from three places — this module, the
 * student form and the staff form — and the first version of this guard lived
 * only here, so both forms could put someone on a route with no rate for them
 * and bill them nothing. A rule enforced in one of three doorways is not a
 * rule.
 */
export async function assertRouteCarries(routeId: string, kind: 'student' | 'staff'): Promise<void> {
  const route = await prisma.transportRoute.findUnique({ where: { id: routeId } });
  if (!route) throw NotFound('Transport route not found');
  if (kind === 'student' && route.studentMonthlyFee === null) {
    throw new AppError(
      `"${route.name}" has no student rate set, so students cannot be assigned to it. Set a student rate on the route first.`,
      409,
      'NO_STUDENT_RATE',
    );
  }
  if (kind === 'staff' && route.staffMonthlyFee === null) {
    throw new AppError(
      `"${route.name}" has no staff rate set, so staff cannot be assigned to it. Set a staff rate on the route first.`,
      409,
      'NO_STAFF_RATE',
    );
  }
}

/** A rate for display: "Rs 1500.00", or plainly that the route does not carry them. */
function rateLabel(v: Prisma.Decimal | null): string {
  return v === null ? 'not carried' : `Rs ${v.toFixed(2)}`;
}

export async function updateRoute(actor: Actor, id: string, input: UpdateRouteInput) {
  const existing = await prisma.transportRoute.findUnique({
    where: { id },
    include: { assignments: { select: { studentId: true, teacherId: true } } },
  });
  if (!existing) throw NotFound('Route not found');

  /*
   * Clearing a rate says the route no longer carries that group — but the
   * people already on it are not removed, and from the next generation they
   * are simply billed nothing. That is money quietly lost with nothing on
   * screen to show for it, so it has to be refused while anyone is still
   * assigned. `assign` guards the way in; this guards the way out.
   */
  const riders = {
    students: existing.assignments.filter((a) => a.studentId).length,
    staff: existing.assignments.filter((a) => a.teacherId).length,
  };
  if (input.studentMonthlyFee === null && riders.students > 0) {
    throw new AppError(
      `"${existing.name}" still carries ${riders.students} student${riders.students === 1 ? '' : 's'}. ` +
        `Move them off the route before clearing its student rate, or they would be billed nothing for transport.`,
      409,
      'ROUTE_HAS_STUDENT_RIDERS',
    );
  }
  if (input.staffMonthlyFee === null && riders.staff > 0) {
    throw new AppError(
      `"${existing.name}" still carries ${riders.staff} staff member${riders.staff === 1 ? '' : 's'}. ` +
        `Move them off the route before clearing its staff rate, or nothing would be deducted from their salary.`,
      409,
      'ROUTE_HAS_STAFF_RIDERS',
    );
  }

  const r = await prisma.transportRoute.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.studentMonthlyFee !== undefined ? { studentMonthlyFee: input.studentMonthlyFee } : {}),
      ...(input.staffMonthlyFee !== undefined ? { staffMonthlyFee: input.staffMonthlyFee } : {}),
      ...(input.vehicleInfo !== undefined ? { vehicleInfo: input.vehicleInfo } : {}),
      ...(input.driverName !== undefined ? { driverName: input.driverName } : {}),
      ...(input.driverPhone !== undefined ? { driverPhone: input.driverPhone } : {}),
      ...(input.stops !== undefined ? { stops: input.stops } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
  });
  // Only what actually moved, with before/after — a rate change on a route is
  // a change to what every rider on it pays.
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  const track = (field: string, before: unknown, after: unknown) => {
    if (String(before) !== String(after)) changes[field] = { before, after };
  };
  track('name', existing.name, r.name);
  track('studentMonthlyFee', rateLabel(existing.studentMonthlyFee), rateLabel(r.studentMonthlyFee));
  track('staffMonthlyFee', rateLabel(existing.staffMonthlyFee), rateLabel(r.staffMonthlyFee));
  track('vehicleInfo', existing.vehicleInfo, r.vehicleInfo);
  track('driverName', existing.driverName, r.driverName);
  track('driverPhone', existing.driverPhone, r.driverPhone);
  track('stops', existing.stops, r.stops);
  track('active', existing.active, r.active);

  const rateChanged = changes.studentMonthlyFee || changes.staffMonthlyFee;
  await audit(actor.userId, 'TRANSPORT_ROUTE_UPDATED', r.id, {
    name: r.name,
    details:
      `Updated transport route "${r.name}"` +
      (rateChanged
        ? `: students ${rateLabel(existing.studentMonthlyFee)} → ${rateLabel(r.studentMonthlyFee)}, ` +
          `staff ${rateLabel(existing.staffMonthlyFee)} → ${rateLabel(r.staffMonthlyFee)}. ` +
          `${riders.students} student(s) and ${riders.staff} staff currently ride it.`
        : `. Changed: ${Object.keys(changes).join(', ') || 'nothing'}.`),
    changes,
  });
  return getRoute(r.id);
}

export async function deleteRoute(actor: Actor, id: string) {
  const count = await prisma.transportAssignment.count({ where: { routeId: id } });
  if (count > 0) {
    throw new AppError(
      `This route still has ${count} rider${count === 1 ? '' : 's'}. Remove them before deleting it.`,
      409,
      'ROUTE_HAS_RIDERS',
    );
  }
  const r = await prisma.transportRoute.findUnique({ where: { id } });
  if (!r) throw NotFound('Route not found');
  await prisma.transportRoute.delete({ where: { id } });
  await audit(actor.userId, 'TRANSPORT_ROUTE_DELETED', id, { name: r.name });
  return { id, deleted: true };
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export async function assign(actor: Actor, input: AssignInput) {
  const route = await prisma.transportRoute.findUnique({ where: { id: input.routeId } });
  if (!route) throw NotFound('Route not found');

  if (input.studentId) {
    const s = await prisma.student.findUnique({ where: { id: input.studentId } });
    if (!s) throw NotFound('Student not found');
    await assertRouteCarries(route.id, 'student');
    await prisma.transportAssignment.upsert({
      where: { studentId: input.studentId },
      create: { routeId: input.routeId, studentId: input.studentId },
      update: { routeId: input.routeId },
    });
    const sName = `${s.firstName}${s.lastName ? ` ${s.lastName}` : ''}`;
    await audit(actor.userId, 'TRANSPORT_ASSIGNED', input.routeId, {
      name: route.name,
      details:
        `${sName} (${s.admissionNo}) was put on transport route "${route.name}". ` +
        `${rateLabel(route.studentMonthlyFee)} per month will be added to their challan from the next generation.`,
      changes: {
        rider: { before: null, after: `${sName} (${s.admissionNo})` },
        studentRate: { before: null, after: rateLabel(route.studentMonthlyFee) },
      },
    });
  } else if (input.teacherId) {
    const t = await prisma.teacherProfile.findUnique({ where: { id: input.teacherId } });
    if (!t) throw NotFound('Teacher not found');
    await assertRouteCarries(route.id, 'staff');
    await prisma.transportAssignment.upsert({
      where: { teacherId: input.teacherId },
      create: { routeId: input.routeId, teacherId: input.teacherId },
      update: { routeId: input.routeId },
    });
    const tUser = await prisma.user.findUnique({ where: { id: t.userId }, select: { fullName: true } });
    const tName = tUser?.fullName ?? t.employeeId;
    await audit(actor.userId, 'TRANSPORT_ASSIGNED', input.routeId, {
      name: route.name,
      details:
        `${tName} (${t.employeeId}) was put on transport route "${route.name}". ` +
        `${rateLabel(route.staffMonthlyFee)} per month will be deducted from their salary when payroll runs.`,
      changes: {
        rider: { before: null, after: `${tName} (${t.employeeId})` },
        staffRate: { before: null, after: rateLabel(route.staffMonthlyFee) },
      },
    });
  }
  return getRoute(input.routeId);
}

export async function unassign(actor: Actor, input: UnassignInput) {
  const where = input.studentId ? { studentId: input.studentId } : { teacherId: input.teacherId! };
  const existing = await prisma.transportAssignment.findFirst({
    where,
    include: {
      route: true,
      student: { select: { firstName: true, lastName: true, admissionNo: true } },
      teacher: { select: { employeeId: true, user: { select: { fullName: true } } } },
    },
  });
  if (!existing) throw NotFound('No transport assignment found');
  await prisma.transportAssignment.delete({ where: { id: existing.id } });

  // Who came off, and what they stop being charged — the figure is the point.
  const rider = existing.student
    ? `${existing.student.firstName}${existing.student.lastName ? ` ${existing.student.lastName}` : ''} (${existing.student.admissionNo})`
    : `${existing.teacher?.user.fullName ?? 'Staff member'} (${existing.teacher?.employeeId ?? '—'})`;
  const rate = existing.student ? existing.route.studentMonthlyFee : existing.route.staffMonthlyFee;

  await audit(actor.userId, 'TRANSPORT_UNASSIGNED', existing.routeId, {
    name: existing.route.name,
    details:
      `${rider} was taken off transport route "${existing.route.name}". ` +
      `${rateLabel(rate)} per month will no longer be charged.`,
    changes: { rider: { before: rider, after: null }, rate: { before: rateLabel(rate), after: null } },
  });
  return { removed: true };
}

/** The route a person currently rides (for forms + previews), or null. */
export async function getPersonRoute(kind: 'student' | 'teacher', id: string) {
  const a = await prisma.transportAssignment.findFirst({
    where: kind === 'student' ? { studentId: id } : { teacherId: id },
    include: { route: true },
  });
  if (!a) return null;
  // Whoever is asking, quote the rate that applies to them.
  const rate = a.studentId ? a.route.studentMonthlyFee : a.route.staffMonthlyFee;
  return { routeId: a.routeId, name: a.route.name, monthlyFee: toMoneyString(rate ?? 0), active: a.route.active };
}

/** Total monthly transport revenue across all riders (dashboard helper). */
export async function transportSummary() {
  const routes = await prisma.transportRoute.findMany({
    where: { active: true },
    include: { assignments: { select: { id: true, studentId: true, teacherId: true } } },
  });
  const totalRoutes = routes.length;
  const totalRiders = routes.reduce((n, r) => n + r.assignments.length, 0);
  const monthlyBilled = sum(
    routes.map((r) =>
      money(r.studentMonthlyFee ?? 0)
        .times(r.assignments.filter((a) => a.studentId).length)
        .plus(money(r.staffMonthlyFee ?? 0).times(r.assignments.filter((a) => a.teacherId).length)),
    ),
  );
  return { totalRoutes, totalRiders, monthlyBilled: toMoneyString(monthlyBilled) };
}
