/**
 * Transport billing — challans and payments for bus fares, kept apart from fees.
 *
 * A route's riders are billed one transport challan a month each. Students and
 * staff are billed the same way; neither fare touches a fee challan or a salary
 * slip any more. Money received settles exactly one transport challan, never a
 * fee, so the two ledgers cannot leak into each other.
 *
 * Status is derived from the payments by the same ledger arithmetic fees use,
 * so "Paid", "Partial" and "Overdue" mean the same thing on both pages.
 */
import { ChallanStatus, FeeItemType, Prisma, Role, StaffRole, TransportPaymentMethod, UserStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError, Forbidden, NotFound } from '../../utils/apiResponse';
import { formatPKR, money, round2, sum, toMoneyString, ZERO } from '../../utils/money';
import { isFuturePktDay, parsePktDay, pktDay, pktDayString } from '../../utils/pktDate';
import { computePayable, deriveStatus, paidBreakdown, type LedgerChallan } from '../fees/fees.ledger';
import { logAudit } from '../audit/audit.service';
import type {
  GenerateTransportChallansInput,
  ListTransportChallansQuery,
  MarkTransportPaidInput,
  ListTransportPaymentsQuery,
  PatchTransportChallanInput,
  RecordTransportPaymentInput,
  TransportPreviewQuery,
} from './transport.schema';

type Tx = Prisma.TransactionClient;

export interface Actor {
  userId: string;
  role: Role;
}

const MONTHS = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const periodLabel = (year: number, month: number) => `${MONTHS[month] ?? month} ${year}`;
const fullName = (first: string, last?: string | null) => `${first}${last ? ` ${last}` : ''}`;
/** The short receipt number the screens and the printed receipt both show. */
export const receiptNoOf = (paymentId: string) => paymentId.slice(-6).toUpperCase();

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const riderInclude = {
  student: {
    select: {
      id: true,
      admissionNo: true,
      firstName: true,
      lastName: true,
      status: true,
      section: { select: { name: true, isDefault: true, class: { select: { name: true } } } },
      parent: { select: { user: { select: { fullName: true, phone: true } } } },
    },
  },
  teacher: {
    select: {
      id: true,
      employeeId: true,
      staffRole: true,
      fatherName: true,
      status: true,
      user: { select: { fullName: true, phone: true } },
    },
  },
} satisfies Prisma.TransportChallanInclude;

const challanInclude = {
  ...riderInclude,
  payments: {
    orderBy: [{ paymentDate: 'asc' }, { createdAt: 'asc' }],
    include: { receivedBy: { select: { fullName: true } }, reversedBy: { select: { fullName: true } } },
  },
} satisfies Prisma.TransportChallanInclude;

type RiderRow = Prisma.TransportChallanGetPayload<{ include: typeof riderInclude }>;
type ChallanRow = Prisma.TransportChallanGetPayload<{ include: typeof challanInclude }>;
type PaymentRow = ChallanRow['payments'][number];

/** A transport challan in the shape the fee ledger maths reads. */
function asLedger(c: {
  amount: Prisma.Decimal;
  dueDate: Date;
  payments: { amount: Prisma.Decimal; isReversed: boolean }[];
}): LedgerChallan {
  return {
    amount: c.amount,
    staffCovered: 0,
    dueDate: c.dueDate,
    allocations: c.payments.map((p) => ({ amountApplied: p.amount, payment: { isReversed: p.isReversed } })),
  };
}

function riderOf(c: Pick<RiderRow, 'student' | 'teacher'>) {
  if (c.student) {
    const s = c.student;
    return {
      kind: 'STUDENT' as const,
      id: s.id,
      name: fullName(s.firstName, s.lastName),
      /** Admission number for a student, employee ID for staff. */
      code: s.admissionNo,
      active: s.status === UserStatus.ACTIVE,
      className: s.section.class.name as string | null,
      sectionName: s.section.name as string | null,
      isDefaultSection: s.section.isDefault,
      staffRole: null as StaffRole | null,
      /** The father/guardian for a student; the staff member's father for staff. */
      guardianName: s.parent.user.fullName,
      phone: s.parent.user.phone,
    };
  }
  const t = c.teacher;
  if (!t) throw new AppError('This transport challan has no rider', 500, 'NO_RIDER');
  return {
    kind: 'STAFF' as const,
    id: t.id,
    name: t.user.fullName,
    code: t.employeeId,
    active: t.status === UserStatus.ACTIVE,
    className: null as string | null,
    sectionName: null as string | null,
    isDefaultSection: false,
    staffRole: t.staffRole as StaffRole | null,
    guardianName: t.fatherName,
    phone: t.user.phone,
  };
}

function shapePayment(p: PaymentRow) {
  return {
    id: p.id,
    receiptNo: receiptNoOf(p.id),
    amount: toMoneyString(p.amount),
    paymentDate: pktDayString(p.paymentDate),
    method: p.method,
    note: p.note,
    receivedByName: p.receivedBy.fullName,
    salarySlipId: p.salarySlipId,
    isReversed: p.isReversed,
    reversedAt: p.reversedAt ? pktDayString(p.reversedAt) : null,
    reversedByName: p.reversedBy?.fullName ?? null,
    reversalReason: p.reversalReason,
    createdAt: p.createdAt.toISOString(),
  };
}

function shapeChallan(c: ChallanRow) {
  const ledger = asLedger(c);
  const { cash, balance } = paidBreakdown(ledger);
  const status = deriveStatus(ledger);
  const lastPaid = c.payments
    .filter((p) => !p.isReversed)
    .map((p) => p.paymentDate)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return {
    id: c.id,
    challanNo: c.challanNo,
    rider: riderOf(c),
    routeId: c.routeId,
    routeName: c.routeName,
    year: c.year,
    month: c.month,
    issueDate: pktDayString(c.issueDate),
    dueDate: pktDayString(c.dueDate),
    baseAmount: toMoneyString(c.baseAmount),
    discount: toMoneyString(c.discount),
    lateFee: toMoneyString(c.lateFee),
    amount: toMoneyString(c.amount),
    paid: toMoneyString(cash),
    balance: toMoneyString(balance.lessThan(0) ? ZERO : balance),
    status,
    /** Past its due date with money still owed — true for a part-paid challan too. */
    isOverdue: balance.greaterThan(0) && pktDay().getTime() > c.dueDate.getTime(),
    lastPaymentDate: lastPaid ? pktDayString(lastPaid) : null,
    note: c.note,
    createdAt: c.createdAt.toISOString(),
    payments: c.payments.map(shapePayment),
  };
}

export type TransportChallanShape = ReturnType<typeof shapeChallan>;

/** A challan plus the rider's earlier unpaid transport months, as a bill shows them. */
async function withDues(c: ChallanRow) {
  const shaped = shapeChallan(c);
  const earlier = await prisma.transportChallan.findMany({
    where: {
      id: { not: c.id },
      ...(c.studentId ? { studentId: c.studentId } : { teacherId: c.teacherId }),
      OR: [{ year: { lt: c.year } }, { year: c.year, month: { lt: c.month } }],
    },
    include: { payments: { select: { amount: true, isReversed: true } } },
    orderBy: [{ year: 'asc' }, { month: 'asc' }],
  });
  const previousDues = earlier
    .map((e) => ({ e, balance: paidBreakdown(asLedger(e)).balance }))
    .filter((x) => x.balance.greaterThan(0))
    .map((x) => ({
      id: x.e.id,
      challanNo: x.e.challanNo,
      year: x.e.year,
      month: x.e.month,
      balance: toMoneyString(x.balance),
      staffBilled: false,
    }));
  const previousBalance = sum(previousDues.map((d) => d.balance));
  return {
    ...shaped,
    previousDues,
    previousBalance: toMoneyString(previousBalance),
    /** Everything owed up to and including this month. */
    totalPayable: toMoneyString(round2(previousBalance.plus(money(shaped.balance)))),
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function nextChallanNo(tx: Tx, year: number): Promise<string> {
  const counter = await tx.transportChallanCounter.upsert({
    where: { year },
    create: { year, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
  });
  return `TR-${year}-${String(counter.lastNumber).padStart(6, '0')}`;
}

async function recompute(tx: Tx, challanId: string) {
  const c = await tx.transportChallan.findUnique({ where: { id: challanId }, include: { payments: true } });
  if (!c) return;
  await tx.transportChallan.update({ where: { id: challanId }, data: { status: deriveStatus(asLedger(c)) } });
}

/** Payments race each other; retry the rare serialization failure rather than surface it. */
async function serializable<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 30_000,
        maxWait: 15_000,
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if ((code === 'P2034' || code === '40001' || code === '40P01') && attempt < 4) continue;
      throw err;
    }
  }
}

async function actorName(userId: string): Promise<string> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } });
  return u?.fullName ?? 'Admin';
}

function riderLabel(r: ReturnType<typeof riderOf>) {
  return `${r.name} (${r.code})`;
}

/** Every word must match somewhere, so "ali garhi" finds Ali on the Garhi route. */
function challanSearch(search?: string): Prisma.TransportChallanWhereInput[] {
  const tokens = (search ?? '').trim().split(/\s+/).filter(Boolean);
  const like = (t: string) => ({ contains: t, mode: 'insensitive' as const });
  return tokens.map((t) => ({
    OR: [
      { challanNo: like(t) },
      { routeName: like(t) },
      { student: { firstName: like(t) } },
      { student: { lastName: like(t) } },
      { student: { admissionNo: like(t) } },
      { teacher: { employeeId: like(t) } },
      { teacher: { user: { fullName: like(t) } } },
    ],
  }));
}

function kindWhere(kind: 'all' | 'students' | 'staff'): Prisma.TransportChallanWhereInput {
  if (kind === 'students') return { studentId: { not: null } };
  if (kind === 'staff') return { teacherId: { not: null } };
  return {};
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Why a rider on a route is not billed this run.
 *
 * ON_FEE_CHALLAN and SALARY_DEDUCTED are the double-billing guards: before
 * transport had challans of its own, a fare went on the student's fee challan
 * or came out of the staff member's pay. A month already charged that way must
 * not be charged again here.
 */
export type TransportSkipReason =
  | 'ALREADY_BILLED'
  | 'ON_FEE_CHALLAN'
  | 'SALARY_DEDUCTED'
  | 'RIDER_INACTIVE'
  | 'ROUTE_INACTIVE'
  | 'NO_RATE'
  | 'FREE_RIDE';

const SKIP_REASONS: TransportSkipReason[] = [
  'ALREADY_BILLED', 'ON_FEE_CHALLAN', 'SALARY_DEDUCTED', 'RIDER_INACTIVE', 'ROUTE_INACTIVE', 'NO_RATE', 'FREE_RIDE',
];

/** Who a run would bill, route by route, and why anyone is left out. */
async function buildPlan(db: Tx, q: { year: number; month: number; routeIds?: string[]; kind: 'all' | 'students' | 'staff' }) {
  const { year, month } = q;
  const routes = await db.transportRoute.findMany({
    where: q.routeIds && q.routeIds.length > 0 ? { id: { in: q.routeIds } } : {},
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
    include: {
      assignments: {
        include: {
          student: {
            select: {
              id: true, admissionNo: true, firstName: true, lastName: true, status: true,
              section: { select: { name: true, isDefault: true, class: { select: { name: true, order: true } } } },
            },
          },
          teacher: { select: { id: true, employeeId: true, staffRole: true, status: true, user: { select: { fullName: true } } } },
        },
      },
    },
  });

  const studentIds = routes.flatMap((r) => r.assignments.map((a) => a.studentId)).filter((x): x is string => !!x);
  const teacherIds = routes.flatMap((r) => r.assignments.map((a) => a.teacherId)).filter((x): x is string => !!x);

  const [existing, onFeeChallans, slips, childCover] = await Promise.all([
    db.transportChallan.findMany({
      where: { year, month, OR: [{ studentId: { in: studentIds } }, { teacherId: { in: teacherIds } }] },
      select: { studentId: true, teacherId: true, challanNo: true },
    }),
    db.feeChallan.findMany({
      where: { year, month, studentId: { in: studentIds }, items: { some: { type: FeeItemType.TRANSPORT } } },
      select: { studentId: true, challanNo: true },
    }),
    db.salarySlip.findMany({
      where: { year, month, teacherId: { in: teacherIds }, staffFeeDeduction: { gt: 0 } },
      select: { teacherId: true, staffFeeDeduction: true },
    }),
    db.feeChallan.groupBy({
      by: ['billedToTeacherId'],
      where: { year, month, billedToTeacherId: { in: teacherIds } },
      _sum: { staffCovered: true },
    }),
  ]);

  const billedStudent = new Map(existing.filter((e) => e.studentId).map((e) => [e.studentId!, e.challanNo]));
  const billedStaff = new Map(existing.filter((e) => e.teacherId).map((e) => [e.teacherId!, e.challanNo]));
  const feeTransport = new Map(onFeeChallans.map((c) => [c.studentId, c.challanNo]));
  const coveredForChildren = new Map(childCover.map((g) => [g.billedToTeacherId, money(g._sum.staffCovered ?? 0)]));
  // The slip stores one blended deduction; what the children's challans did
  // not absorb was the staff member's own fare.
  const salaryDeducted = new Set(
    slips
      .filter((s) => money(s.staffFeeDeduction).minus(coveredForChildren.get(s.teacherId) ?? ZERO).greaterThan(0))
      .map((s) => s.teacherId),
  );

  const skipped = Object.fromEntries(SKIP_REASONS.map((r) => [r, 0])) as Record<TransportSkipReason, number>;

  const plannedRoutes = routes.map((r) => {
    const riders = r.assignments
      .filter((a) => (a.studentId ? q.kind !== 'staff' : q.kind !== 'students'))
      .map((a) => {
        const isStudent = !!a.student;
        const rate = isStudent ? r.studentMonthlyFee : r.staffMonthlyFee;
        const riderActive = isStudent ? a.student!.status === UserStatus.ACTIVE : a.teacher!.status === UserStatus.ACTIVE;

        let reason: TransportSkipReason | null = null;
        let existingChallanNo: string | null = null;
        const already = isStudent ? billedStudent.get(a.studentId!) : billedStaff.get(a.teacherId!);
        if (already) {
          reason = 'ALREADY_BILLED';
          existingChallanNo = already;
        } else if (!riderActive) reason = 'RIDER_INACTIVE';
        else if (!r.active) reason = 'ROUTE_INACTIVE';
        else if (rate === null) reason = 'NO_RATE';
        else if (money(rate).lessThanOrEqualTo(0)) reason = 'FREE_RIDE';
        else if (isStudent && feeTransport.has(a.studentId!)) {
          reason = 'ON_FEE_CHALLAN';
          existingChallanNo = feeTransport.get(a.studentId!) ?? null;
        } else if (!isStudent && salaryDeducted.has(a.teacherId!)) reason = 'SALARY_DEDUCTED';

        if (reason) skipped[reason]++;
        return {
          key: isStudent ? `student:${a.studentId}` : `staff:${a.teacherId}`,
          kind: isStudent ? ('STUDENT' as const) : ('STAFF' as const),
          riderId: (isStudent ? a.studentId : a.teacherId)!,
          name: isStudent ? fullName(a.student!.firstName, a.student!.lastName) : a.teacher!.user.fullName,
          code: isStudent ? a.student!.admissionNo : a.teacher!.employeeId,
          className: isStudent ? a.student!.section.class.name : null,
          sectionName: isStudent ? a.student!.section.name : null,
          isDefaultSection: isStudent ? a.student!.section.isDefault : false,
          staffRole: isStudent ? null : a.teacher!.staffRole,
          classOrder: isStudent ? a.student!.section.class.order : Number.MAX_SAFE_INTEGER,
          rate: rate === null ? null : toMoneyString(rate),
          willBill: reason === null,
          reason,
          existingChallanNo,
        };
      })
      .sort((x, y) => (x.kind === y.kind ? x.classOrder - y.classOrder || x.name.localeCompare(y.name) : x.kind === 'STUDENT' ? -1 : 1))
      .map(({ classOrder: _order, ...row }) => row);

    const billable = riders.filter((x) => x.willBill);
    return {
      routeId: r.id,
      routeName: r.name,
      active: r.active,
      studentRate: r.studentMonthlyFee === null ? null : toMoneyString(r.studentMonthlyFee),
      staffRate: r.staffMonthlyFee === null ? null : toMoneyString(r.staffMonthlyFee),
      riders,
      willBill: billable.length,
      total: toMoneyString(sum(billable.map((x) => x.rate ?? 0))),
    };
  });

  return {
    year,
    month,
    routes: plannedRoutes,
    totals: {
      riders: plannedRoutes.reduce((n, r) => n + r.riders.length, 0),
      willBill: plannedRoutes.reduce((n, r) => n + r.willBill, 0),
      total: toMoneyString(sum(plannedRoutes.map((r) => r.total))),
      skipped,
    },
  };
}

export async function previewTransportChallans(q: TransportPreviewQuery) {
  return buildPlan(prisma, { year: q.year, month: q.month, kind: q.kind, routeIds: q.routeId ? [q.routeId] : undefined });
}

export async function generateTransportChallans(actor: Actor, input: GenerateTransportChallansInput) {
  const due = parsePktDay(input.dueDate);
  const exclude = new Set(input.excludeRiders ?? []);
  /** When set, nobody outside this list is billed. */
  const only = input.onlyRiders ? new Set(input.onlyRiders) : null;

  const result = await prisma.$transaction(
    async (tx) => {
      // Planned inside the transaction so a concurrent run cannot slip a
      // duplicate between the check and the insert.
      const plan = await buildPlan(tx, input);
      const created: { challanNo: string; rider: string; route: string; amount: string }[] = [];
      let total = ZERO;
      let excluded = 0;
      /** People picked by hand who could not be billed, and why — so the run says so. */
      const pickedButSkipped: { rider: string; route: string; reason: string; existingChallanNo: string | null }[] = [];
      const status = pktDay().getTime() > due.getTime() ? ChallanStatus.OVERDUE : ChallanStatus.UNPAID;

      for (const route of plan.routes) {
        for (const row of route.riders) {
          if (only && !only.has(row.key)) continue;
          if (!row.willBill) {
            if (only) {
              pickedButSkipped.push({
                rider: `${row.name} (${row.code})`,
                route: route.routeName,
                reason: row.reason ?? 'UNKNOWN',
                existingChallanNo: row.existingChallanNo,
              });
            }
            continue;
          }
          if (exclude.has(row.key)) {
            excluded++;
            continue;
          }
          const amount = money(row.rate ?? 0);
          const challanNo = await nextChallanNo(tx, input.year);
          await tx.transportChallan.create({
            data: {
              challanNo,
              studentId: row.kind === 'STUDENT' ? row.riderId : null,
              teacherId: row.kind === 'STAFF' ? row.riderId : null,
              routeId: route.routeId,
              routeName: route.routeName,
              year: input.year,
              month: input.month,
              baseAmount: amount,
              amount,
              dueDate: due,
              status,
              generatedById: actor.userId,
            },
          });
          created.push({ challanNo, rider: `${row.name} (${row.code})`, route: route.routeName, amount: toMoneyString(amount) });
          total = total.plus(amount);
        }
      }
      return { plan, created, total, excluded, pickedButSkipped };
    },
    { timeout: 120_000, maxWait: 20_000 },
  );

  const period = periodLabel(input.year, input.month);
  const skippedTotal = Object.values(result.plan.totals.skipped).reduce((a, b) => a + b, 0);
  const selection = only
    ? `${only.size} selected rider(s)`
    : input.kind === 'students'
      ? 'All student riders'
      : input.kind === 'staff'
        ? 'All staff riders'
        : 'All riders';
  await logAudit(null, {
    actorId: actor.userId,
    actorName: await actorName(actor.userId),
    actorRole: actor.role,
    action: 'CREATE',
    module: 'FEES',
    targetType: 'TransportChallan',
    targetId: `${input.year}-${input.month}`,
    targetLabel: `Transport Challans (${input.year}-${String(input.month).padStart(2, '0')})`,
    details:
      `Generated ${result.created.length} transport challan(s) totalling Rs ${toMoneyString(result.total)} for ${period}, due ${input.dueDate} — ${selection}` +
      (only
        ? result.pickedButSkipped.length
          ? `. ${result.pickedButSkipped.length} of the selected could not be billed: ${result.pickedButSkipped.map((p) => `${p.rider} (${p.reason.replace(/_/g, ' ').toLowerCase()})`).join(', ')}`
          : ''
        : skippedTotal
          ? `. ${skippedTotal} rider(s) not billed (already billed, inactive, or no rate)`
          : '') +
      (result.excluded ? `. ${result.excluded} rider(s) left out by hand` : ''),
    changes: {
      challansCreated: { before: 0, after: result.created.length },
      totalAmount: { before: '0.00', after: toMoneyString(result.total) },
      _meta: {
        period,
        dueDate: input.dueDate,
        kind: input.kind,
        selection,
        routes: result.plan.routes.map((r) => r.routeName),
        // For a run over chosen people, the route-wide skip counts describe
        // riders nobody asked about; what matters is who was picked and missed.
        ...(only ? { selectedNotBilled: result.pickedButSkipped } : { skipped: result.plan.totals.skipped }),
        excluded: result.excluded,
        challans: result.created,
      },
    },
  });

  return {
    created: result.created.length,
    excluded: result.excluded,
    skipped: result.plan.totals.skipped,
    selectedNotBilled: result.pickedButSkipped,
    totalAmount: toMoneyString(result.total),
  };
}

// ---------------------------------------------------------------------------
// Reading challans
// ---------------------------------------------------------------------------

export async function listTransportChallans(q: ListTransportChallansQuery) {
  const search = challanSearch(q.search);
  const rows = await prisma.transportChallan.findMany({
    where: {
      ...(typeof q.year === 'number' ? { year: q.year } : {}),
      ...(typeof q.month === 'number' ? { month: q.month } : {}),
      ...(q.routeId ? { routeId: q.routeId } : {}),
      ...kindWhere(q.kind),
      ...(search.length ? { AND: search } : {}),
    },
    include: challanInclude,
    orderBy: [{ year: 'desc' }, { month: 'desc' }, { routeName: 'asc' }, { challanNo: 'asc' }],
    take: 5000,
  });
  const all = rows.map(shapeChallan);

  // Status is derived per row, so it is filtered here rather than in SQL — a
  // stored UNPAID goes OVERDUE by the calendar alone.
  const owes = (c: TransportChallanShape) => Number(c.balance) > 0;
  const items = all.filter((c) =>
    q.status === 'all' ? true : q.status === 'outstanding' ? owes(c) : c.status === q.status,
  );

  // Counts over everything the other filters match, so each status tab can say
  // what switching to it would show.
  const count = (s: ChallanStatus) => all.filter((c) => c.status === s).length;
  return {
    items,
    stats: {
      count: all.length,
      billed: toMoneyString(sum(all.map((c) => c.amount))),
      collected: toMoneyString(sum(all.map((c) => c.paid))),
      outstanding: toMoneyString(sum(all.map((c) => c.balance))),
      outstandingCount: all.filter(owes).length,
      paid: count(ChallanStatus.PAID),
      unpaid: count(ChallanStatus.UNPAID),
      partial: count(ChallanStatus.PARTIAL),
      overdue: count(ChallanStatus.OVERDUE),
      waived: count(ChallanStatus.WAIVED),
    },
  };
}

export async function getTransportChallan(id: string) {
  const c = await prisma.transportChallan.findUnique({ where: { id }, include: challanInclude });
  if (!c) throw NotFound('Transport challan not found');
  return withDues(c);
}

export type TransportChallanDetail = Awaited<ReturnType<typeof getTransportChallan>>;

// ---------------------------------------------------------------------------
// Changing challans
// ---------------------------------------------------------------------------

export async function patchTransportChallan(actor: Actor, id: string, input: PatchTransportChallanInput) {
  const { before, after } = await prisma.$transaction(async (tx) => {
    const c = await tx.transportChallan.findUnique({ where: { id }, include: { payments: true } });
    if (!c) throw NotFound('Transport challan not found');
    if (deriveStatus(asLedger(c)) === ChallanStatus.PAID) {
      throw new AppError(
        'This challan is fully paid, so it can no longer be changed. Reverse its payment first if something needs correcting.',
        409,
        'CHALLAN_PAID',
      );
    }

    const next = computePayable(
      [input.baseAmount ?? c.baseAmount],
      input.discount ?? c.discount,
      input.lateFee ?? c.lateFee,
    );
    const { cash } = paidBreakdown(asLedger(c));
    if (next.amount.lessThan(cash)) {
      throw new AppError(
        `${formatPKR(cash)} has already been paid against this challan, so it cannot be brought down to ${formatPKR(next.amount)}.`,
        409,
        'BELOW_PAID',
      );
    }

    const updated = await tx.transportChallan.update({
      where: { id },
      data: {
        baseAmount: next.base,
        discount: next.discount,
        lateFee: next.lateFee,
        amount: next.amount,
        ...(input.dueDate ? { dueDate: parsePktDay(input.dueDate) } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
      include: { payments: true },
    });
    await tx.transportChallan.update({ where: { id }, data: { status: deriveStatus(asLedger(updated)) } });
    return { before: c, after: updated };
  });

  const changes: Record<string, { before: unknown; after: unknown }> = {};
  const track = (field: string, b: unknown, a: unknown) => {
    if (String(b) !== String(a)) changes[field] = { before: b, after: a };
  };
  track('baseAmount', toMoneyString(before.baseAmount), toMoneyString(after.baseAmount));
  track('discount', toMoneyString(before.discount), toMoneyString(after.discount));
  track('lateFee', toMoneyString(before.lateFee), toMoneyString(after.lateFee));
  track('amount', toMoneyString(before.amount), toMoneyString(after.amount));
  track('dueDate', pktDayString(before.dueDate), pktDayString(after.dueDate));
  track('note', before.note, after.note);

  const detail = await getTransportChallan(id);
  await logAudit(null, {
    actorId: actor.userId,
    actorName: await actorName(actor.userId),
    actorRole: actor.role,
    action: 'UPDATE',
    module: 'FEES',
    targetType: 'TransportChallan',
    targetId: id,
    targetLabel: `${riderLabel(detail.rider)} (Transport #${detail.challanNo})`,
    details:
      `Adjusted transport challan ${detail.challanNo} for ${periodLabel(detail.year, detail.month)}: ` +
      (Object.keys(changes).length ? Object.entries(changes).map(([k, v]) => `${k} ${v.before} → ${v.after}`).join(', ') : 'no change'),
    changes,
  });
  return detail;
}

export async function deleteTransportChallan(actor: Actor, id: string) {
  const c = await prisma.transportChallan.findUnique({ where: { id }, include: { ...riderInclude, payments: true } });
  if (!c) throw NotFound('Transport challan not found');
  if (c.payments.length > 0) {
    throw new AppError(
      'This challan has payments recorded against it, so it is kept as a record. Reverse a payment instead of deleting the bill.',
      409,
      'HAS_PAYMENTS',
    );
  }
  const rider = riderOf(c);
  await prisma.transportChallan.delete({ where: { id } });
  await logAudit(null, {
    actorId: actor.userId,
    actorName: await actorName(actor.userId),
    actorRole: actor.role,
    action: 'DELETE',
    module: 'FEES',
    targetType: 'TransportChallan',
    targetId: id,
    targetLabel: `${riderLabel(rider)} (Transport #${c.challanNo})`,
    details: `Deleted transport challan ${c.challanNo} (${formatPKR(c.amount)}, ${c.routeName}, ${periodLabel(c.year, c.month)}) for ${riderLabel(rider)}`,
    changes: { challanNo: { before: c.challanNo, after: null }, amount: { before: toMoneyString(c.amount), after: null } },
  });
  return { id, deleted: true };
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export async function recordTransportPayment(actor: Actor, input: RecordTransportPaymentInput) {
  const day = parsePktDay(input.paymentDate);
  if (isFuturePktDay(day)) {
    throw new AppError('The payment date cannot be in the future.', 422, 'FUTURE_DATE');
  }

  const paymentId = await serializable(async (tx) => {
    const c = await tx.transportChallan.findUnique({ where: { id: input.challanId }, include: { payments: true } });
    if (!c) throw NotFound('Transport challan not found');
    const { balance } = paidBreakdown(asLedger(c));
    if (balance.lessThanOrEqualTo(0)) {
      throw new AppError('Nothing is owed on this challan.', 409, 'ALREADY_SETTLED');
    }
    /*
     * A transport payment settles this challan and nothing else, so there is
     * nowhere for a surplus to go. Fees keep extra money as credit; doing that
     * here would recreate the shared ledger this module exists to avoid.
     */
    if (money(input.amount).greaterThan(balance)) {
      throw new AppError(
        `Only ${formatPKR(balance)} is due on this challan. Enter that amount or less.`,
        409,
        'OVERPAYMENT',
      );
    }
    const p = await tx.transportPayment.create({
      data: {
        challanId: c.id,
        amount: input.amount,
        paymentDate: day,
        method: input.method as TransportPaymentMethod,
        receivedById: actor.userId,
        note: input.note ?? null,
      },
    });
    await recompute(tx, c.id);
    return p.id;
  });

  const detail = await getTransportChallan(input.challanId);
  await logAudit(null, {
    actorId: actor.userId,
    actorName: await actorName(actor.userId),
    actorRole: actor.role,
    action: 'PAYMENT',
    module: 'FEES',
    targetType: 'TransportPayment',
    targetId: paymentId,
    targetLabel: `${riderLabel(detail.rider)} (Transport #${detail.challanNo})`,
    details:
      `Received ${formatPKR(input.amount)} (${input.method.replace('_', ' ').toLowerCase()}) against transport challan ` +
      `${detail.challanNo} for ${periodLabel(detail.year, detail.month)} — balance now ${formatPKR(detail.balance)}`,
    changes: {
      amount: { before: null, after: input.amount },
      balance: { before: null, after: detail.balance },
      receiptNo: { before: null, after: receiptNoOf(paymentId) },
    },
  });
  return { paymentId, receiptNo: receiptNoOf(paymentId), challan: detail };
}

/**
 * Record full payment for several challans at once — a real payment each, for
 * whatever that challan still owes. Settled challans are skipped, so running it
 * twice cannot take the money twice.
 */
export async function markTransportChallansPaid(actor: Actor, input: MarkTransportPaidInput) {
  const day = parsePktDay(input.paymentDate);
  if (isFuturePktDay(day)) {
    throw new AppError('The payment date cannot be in the future.', 422, 'FUTURE_DATE');
  }

  const result = await prisma.$transaction(
    async (tx) => {
      const challans = await tx.transportChallan.findMany({
        where: { id: { in: input.challanIds } },
        include: { payments: true, ...riderInclude },
      });
      const paid: { challanNo: string; rider: string; amount: string }[] = [];
      let skipped = 0;
      let total = ZERO;
      for (const c of challans) {
        const { balance } = paidBreakdown(asLedger(c));
        if (balance.lessThanOrEqualTo(0)) {
          skipped++;
          continue;
        }
        await tx.transportPayment.create({
          data: {
            challanId: c.id,
            amount: balance,
            paymentDate: day,
            method: input.method as TransportPaymentMethod,
            receivedById: actor.userId,
            note: input.note ?? null,
          },
        });
        await recompute(tx, c.id);
        paid.push({ challanNo: c.challanNo, rider: riderLabel(riderOf(c)), amount: toMoneyString(balance) });
        total = total.plus(balance);
      }
      return { paid, skipped, total, missing: input.challanIds.length - challans.length };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 120_000, maxWait: 20_000 },
  );

  if (result.paid.length > 0) {
    await logAudit(null, {
      actorId: actor.userId,
      actorName: await actorName(actor.userId),
      actorRole: actor.role,
      action: 'PAYMENT',
      module: 'FEES',
      targetType: 'TransportPayment',
      targetId: null,
      targetLabel: `${result.paid.length} transport challan(s) marked paid`,
      details:
        `Marked ${result.paid.length} transport challan(s) paid in full (${input.method.replace('_', ' ').toLowerCase()}, ` +
        `${input.paymentDate}) — ${formatPKR(result.total)} received` +
        (result.skipped ? `. ${result.skipped} were already settled and left alone` : ''),
      changes: { _meta: { paymentDate: input.paymentDate, method: input.method, challans: result.paid } },
    });
  }

  return {
    paid: result.paid.length,
    skipped: result.skipped + result.missing,
    totalAmount: toMoneyString(result.total),
  };
}

export async function reverseTransportPayment(actor: Actor, paymentId: string, reason: string) {
  const p = await prisma.transportPayment.findUnique({ where: { id: paymentId } });
  if (!p) throw NotFound('Payment not found');
  if (p.isReversed) throw new AppError('This payment has already been reversed.', 409, 'ALREADY_REVERSED');

  await serializable(async (tx) => {
    await tx.transportPayment.update({
      where: { id: paymentId },
      data: { isReversed: true, reversedAt: new Date(), reversedById: actor.userId, reversalReason: reason },
    });
    await recompute(tx, p.challanId);
  });

  const detail = await getTransportChallan(p.challanId);
  await logAudit(null, {
    actorId: actor.userId,
    actorName: await actorName(actor.userId),
    actorRole: actor.role,
    action: 'REVERSE',
    module: 'FEES',
    targetType: 'TransportPayment',
    targetId: paymentId,
    targetLabel: `${riderLabel(detail.rider)} (Transport #${detail.challanNo})`,
    details:
      `Reversed transport receipt #${receiptNoOf(paymentId)} of ${formatPKR(p.amount)} on ${detail.challanNo} — ` +
      `reason: ${reason}. Balance now ${formatPKR(detail.balance)}`,
    changes: { isReversed: { before: false, after: true }, reason: { before: null, after: reason } },
  });
  return detail;
}

/**
 * Permanently remove a transport payment.
 *
 * A reversal is the right tool for a real receipt entered in error — it keeps
 * the row. Deleting is for a receipt that should never have existed (a
 * duplicate, a test entry, a reversed receipt being cleared so its challan can
 * be deleted). The row is gone afterwards, so the audit entry carries
 * everything about it: amount, method, date, who took it, and the challan's
 * balance before and after.
 */
export async function deleteTransportPayment(actor: Actor, paymentId: string, reason: string) {
  const p = await prisma.transportPayment.findUnique({
    where: { id: paymentId },
    include: { receivedBy: { select: { fullName: true } }, reversedBy: { select: { fullName: true } } },
  });
  if (!p) throw NotFound('Payment not found');

  const before = await getTransportChallan(p.challanId);
  await serializable(async (tx) => {
    await tx.transportPayment.delete({ where: { id: paymentId } });
    await recompute(tx, p.challanId);
  });
  const after = await getTransportChallan(p.challanId);

  const receiptNo = receiptNoOf(p.id);
  const method = p.method.replace(/_/g, ' ').toLowerCase();
  await logAudit(null, {
    actorId: actor.userId,
    actorName: await actorName(actor.userId),
    actorRole: actor.role,
    action: 'DELETE',
    module: 'FEES',
    targetType: 'TransportPayment',
    targetId: paymentId,
    targetLabel: `${riderLabel(after.rider)} (Transport #${after.challanNo}) — Rs ${toMoneyString(p.amount)}`,
    details:
      `Permanently deleted transport receipt #${receiptNo} of ${formatPKR(p.amount)} (${method}, dated ${pktDayString(p.paymentDate)}` +
      `${p.isReversed ? ', already reversed' : ''}) on challan ${after.challanNo} for ${periodLabel(after.year, after.month)}. ` +
      `Reason: ${reason}. Balance ${formatPKR(before.balance)} → ${formatPKR(after.balance)}`,
    changes: {
      receiptNo: { before: receiptNo, after: null },
      amount: { before: toMoneyString(p.amount), after: null },
      method: { before: p.method, after: null },
      paymentDate: { before: pktDayString(p.paymentDate), after: null },
      challanBalance: { before: before.balance, after: after.balance },
      challanStatus: { before: before.status, after: after.status },
      _meta: {
        reason,
        challanNo: after.challanNo,
        rider: riderLabel(after.rider),
        route: after.routeName,
        period: periodLabel(after.year, after.month),
        receivedBy: p.receivedBy.fullName,
        note: p.note,
        wasReversed: p.isReversed,
        reversalReason: p.reversalReason,
        reversedBy: p.reversedBy?.fullName ?? null,
        salarySlipId: p.salarySlipId,
      },
    },
  });

  return { deleted: true, challan: after };
}

export async function listTransportPayments(q: ListTransportPaymentsQuery) {
  const search = challanSearch(q.search);
  const rows = await prisma.transportPayment.findMany({
    where: {
      ...(q.from || q.to
        ? { paymentDate: { ...(q.from ? { gte: parsePktDay(q.from) } : {}), ...(q.to ? { lte: parsePktDay(q.to) } : {}) } }
        : {}),
      ...(q.method !== 'all' ? { method: q.method } : {}),
      ...(q.state === 'active' ? { isReversed: false } : q.state === 'reversed' ? { isReversed: true } : {}),
      challan: {
        ...(q.routeId ? { routeId: q.routeId } : {}),
        ...kindWhere(q.kind),
        ...(search.length ? { AND: search } : {}),
      },
    },
    include: {
      receivedBy: { select: { fullName: true } },
      reversedBy: { select: { fullName: true } },
      challan: { include: riderInclude },
    },
    orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }],
    take: 5000,
  });

  const items = rows.map((p) => ({
    ...shapePayment(p),
    challan: {
      id: p.challan.id,
      challanNo: p.challan.challanNo,
      year: p.challan.year,
      month: p.challan.month,
      routeId: p.challan.routeId,
      routeName: p.challan.routeName,
      amount: toMoneyString(p.challan.amount),
      rider: riderOf(p.challan),
    },
  }));

  const live = rows.filter((p) => !p.isReversed);
  const isDeduction = (p: (typeof rows)[number]) => p.method === TransportPaymentMethod.SALARY_DEDUCTION;
  return {
    items,
    stats: {
      count: live.length,
      /** Money actually handed over — a salary deduction is not cash received. */
      collected: toMoneyString(sum(live.filter((p) => !isDeduction(p)).map((p) => p.amount))),
      cash: toMoneyString(sum(live.filter((p) => p.method === TransportPaymentMethod.CASH).map((p) => p.amount))),
      nonCash: toMoneyString(
        sum(live.filter((p) => p.method !== TransportPaymentMethod.CASH && !isDeduction(p)).map((p) => p.amount)),
      ),
      salaryDeducted: toMoneyString(sum(live.filter(isDeduction).map((p) => p.amount))),
      reversedCount: rows.length - live.length,
    },
  };
}

// ---------------------------------------------------------------------------
// One rider's transport: profiles, the parent dashboard, the staff dashboard
// ---------------------------------------------------------------------------

export async function riderTransport(who: { studentId: string } | { teacherId: string }) {
  const isStudent = 'studentId' in who;
  const [assignment, rows] = await Promise.all([
    prisma.transportAssignment.findFirst({ where: who, include: { route: true } }),
    prisma.transportChallan.findMany({ where: who, include: challanInclude, orderBy: [{ year: 'desc' }, { month: 'desc' }] }),
  ]);
  const challans = rows.map(shapeChallan);
  const rate = assignment ? (isStudent ? assignment.route.studentMonthlyFee : assignment.route.staffMonthlyFee) : null;
  return {
    route: assignment
      ? {
          routeId: assignment.routeId,
          name: assignment.route.name,
          monthlyFee: rate === null ? null : toMoneyString(rate),
          active: assignment.route.active,
        }
      : null,
    challans,
    outstanding: toMoneyString(sum(challans.map((c) => c.balance))),
    paidTotal: toMoneyString(sum(challans.map((c) => c.paid))),
  };
}

export async function getStudentRiderTransport(studentId: string) {
  const s = await prisma.student.findUnique({ where: { id: studentId }, select: { id: true } });
  if (!s) throw NotFound('Student not found');
  return riderTransport({ studentId });
}

export async function getStaffRiderTransport(teacherId: string) {
  const t = await prisma.teacherProfile.findUnique({ where: { id: teacherId }, select: { id: true } });
  if (!t) throw NotFound('Staff member not found');
  return riderTransport({ teacherId });
}

async function assertOwnChild(userId: string, studentId: string) {
  const s = await prisma.student.findUnique({ where: { id: studentId }, select: { parent: { select: { userId: true } } } });
  if (!s) throw NotFound('Student not found');
  if (s.parent.userId !== userId) throw Forbidden('This student is not your child');
}

async function myTeacherId(userId: string): Promise<string> {
  const t = await prisma.teacherProfile.findUnique({ where: { userId }, select: { id: true } });
  if (!t) throw NotFound('Staff profile not found');
  return t.id;
}

export async function getChildTransportForParent(userId: string, studentId: string) {
  await assertOwnChild(userId, studentId);
  return riderTransport({ studentId });
}

export async function getMyStaffTransport(userId: string) {
  return riderTransport({ teacherId: await myTeacherId(userId) });
}

/**
 * Check a guardian may print this challan, returning its id.
 *
 * A challan that belongs to someone else answers 404, not 403, so the endpoint
 * does not confirm that another family's bill exists.
 */
export async function assertOwnTransportChallan(
  userId: string,
  scope: { kind: 'parent'; studentId: string } | { kind: 'staff' },
  challanId: string,
): Promise<string> {
  const c = await prisma.transportChallan.findUnique({ where: { id: challanId }, select: { studentId: true, teacherId: true } });
  if (scope.kind === 'parent') {
    await assertOwnChild(userId, scope.studentId);
    if (!c || c.studentId !== scope.studentId) throw NotFound('Transport challan not found');
  } else {
    const teacherId = await myTeacherId(userId);
    if (!c || c.teacherId !== teacherId) throw NotFound('Transport challan not found');
  }
  return challanId;
}
