import { Prisma, Role } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError, NotFound } from '../../utils/apiResponse';
import { toMoneyString, sum, money } from '../../utils/money';
import type { CreateRouteInput, UpdateRouteInput, AssignInput, UnassignInput } from './transport.schema';

export interface Actor {
  userId: string;
  role: Role;
}

async function audit(userId: string, action: string, entityId: string, metadata: Record<string, unknown>) {
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
      monthlyFee: toMoneyString(r.monthlyFee),
      vehicleInfo: r.vehicleInfo,
      driverName: r.driverName,
      driverPhone: r.driverPhone,
      stops: r.stops,
      active: r.active,
      studentRiders,
      teacherRiders,
      riders,
      monthlyTotal: toMoneyString(money(r.monthlyFee).times(riders)),
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
      isStaffChild: !!a.student!.teacherParentId,
    }));
  const teachers = r.assignments
    .filter((a) => a.teacher)
    .map((a) => ({
      assignmentId: a.id,
      id: a.teacher!.id,
      name: a.teacher!.user.fullName,
      employeeId: a.teacher!.employeeId,
    }));

  return {
    id: r.id,
    name: r.name,
    monthlyFee: toMoneyString(r.monthlyFee),
    vehicleInfo: r.vehicleInfo,
    driverName: r.driverName,
    driverPhone: r.driverPhone,
    stops: r.stops,
    active: r.active,
    students,
    teachers,
    monthlyTotal: toMoneyString(money(r.monthlyFee).times(students.length + teachers.length)),
  };
}

export async function createRoute(actor: Actor, input: CreateRouteInput) {
  const r = await prisma.transportRoute.create({
    data: {
      name: input.name,
      monthlyFee: input.monthlyFee,
      vehicleInfo: input.vehicleInfo ?? null,
      driverName: input.driverName ?? null,
      driverPhone: input.driverPhone ?? null,
      stops: input.stops ?? null,
      active: input.active ?? true,
    },
  });
  await audit(actor.userId, 'TRANSPORT_ROUTE_CREATED', r.id, { name: r.name, monthlyFee: r.monthlyFee.toString() });
  return getRoute(r.id);
}

export async function updateRoute(actor: Actor, id: string, input: UpdateRouteInput) {
  const existing = await prisma.transportRoute.findUnique({ where: { id } });
  if (!existing) throw NotFound('Route not found');
  const r = await prisma.transportRoute.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.monthlyFee !== undefined ? { monthlyFee: input.monthlyFee } : {}),
      ...(input.vehicleInfo !== undefined ? { vehicleInfo: input.vehicleInfo } : {}),
      ...(input.driverName !== undefined ? { driverName: input.driverName } : {}),
      ...(input.driverPhone !== undefined ? { driverPhone: input.driverPhone } : {}),
      ...(input.stops !== undefined ? { stops: input.stops } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
  });
  await audit(actor.userId, 'TRANSPORT_ROUTE_UPDATED', r.id, { name: r.name });
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
    await prisma.transportAssignment.upsert({
      where: { studentId: input.studentId },
      create: { routeId: input.routeId, studentId: input.studentId },
      update: { routeId: input.routeId },
    });
    await audit(actor.userId, 'TRANSPORT_ASSIGNED', input.routeId, { studentId: input.studentId });
  } else if (input.teacherId) {
    const t = await prisma.teacherProfile.findUnique({ where: { id: input.teacherId } });
    if (!t) throw NotFound('Teacher not found');
    await prisma.transportAssignment.upsert({
      where: { teacherId: input.teacherId },
      create: { routeId: input.routeId, teacherId: input.teacherId },
      update: { routeId: input.routeId },
    });
    await audit(actor.userId, 'TRANSPORT_ASSIGNED', input.routeId, { teacherId: input.teacherId });
  }
  return getRoute(input.routeId);
}

export async function unassign(actor: Actor, input: UnassignInput) {
  const where = input.studentId ? { studentId: input.studentId } : { teacherId: input.teacherId! };
  const existing = await prisma.transportAssignment.findFirst({ where });
  if (!existing) throw NotFound('No transport assignment found');
  await prisma.transportAssignment.delete({ where: { id: existing.id } });
  await audit(actor.userId, 'TRANSPORT_UNASSIGNED', existing.routeId, where);
  return { removed: true };
}

/** The route a person currently rides (for forms + previews), or null. */
export async function getPersonRoute(kind: 'student' | 'teacher', id: string) {
  const a = await prisma.transportAssignment.findFirst({
    where: kind === 'student' ? { studentId: id } : { teacherId: id },
    include: { route: true },
  });
  if (!a) return null;
  return { routeId: a.routeId, name: a.route.name, monthlyFee: toMoneyString(a.route.monthlyFee), active: a.route.active };
}

/** Total monthly transport revenue across all riders (dashboard helper). */
export async function transportSummary() {
  const routes = await prisma.transportRoute.findMany({
    where: { active: true },
    include: { assignments: { select: { id: true } } },
  });
  const totalRoutes = routes.length;
  const totalRiders = routes.reduce((n, r) => n + r.assignments.length, 0);
  const monthlyBilled = sum(routes.map((r) => money(r.monthlyFee).times(r.assignments.length)));
  return { totalRoutes, totalRiders, monthlyBilled: toMoneyString(monthlyBilled) };
}
