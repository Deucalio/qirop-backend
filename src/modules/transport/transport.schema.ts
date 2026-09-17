import { z } from 'zod';

const MAX_MONEY = 99_999_999.99;
/** Money input: number|string → canonical 2dp string; rejects negatives/NaN/>2dp. */
const moneyInput = (opts: { min?: number } = {}) =>
  z.union([z.number(), z.string()]).transform((v, ctx) => {
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    if (!Number.isFinite(n)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid amount' });
      return z.NEVER;
    }
    const min = opts.min ?? 0;
    if (n < min) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Amount cannot be less than ${min}` });
      return z.NEVER;
    }
    if (n > MAX_MONEY) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Amount is too large' });
      return z.NEVER;
    }
    if (Math.round(n * 100) / 100 !== n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Amount can have at most 2 decimal places' });
      return z.NEVER;
    }
    return n.toFixed(2);
  });

export const createRouteSchema = z.object({
  name: z.string().trim().min(1, 'Route name is required').max(80),
  /*
   * Both rates are optional, and null is meaningful: it says this route does
   * not carry that kind of rider, which is why assigning one is then refused.
   * Zero is a different statement — a free ride — and stays expressible.
   */
  studentMonthlyFee: moneyInput({ min: 0 }).nullable().optional(),
  staffMonthlyFee: moneyInput({ min: 0 }).nullable().optional(),
  vehicleInfo: z.string().trim().max(80).nullable().optional(),
  driverName: z.string().trim().max(80).nullable().optional(),
  driverPhone: z.string().trim().max(30).nullable().optional(),
  stops: z.string().trim().max(500).nullable().optional(),
  active: z.boolean().optional(),
});

export const updateRouteSchema = createRouteSchema.partial();

// Assign a route to exactly one of a student or a teacher.
export const assignSchema = z
  .object({
    routeId: z.string().min(1),
    studentId: z.string().min(1).optional(),
    teacherId: z.string().min(1).optional(),
  })
  .refine((v) => !!v.studentId !== !!v.teacherId, {
    message: 'Provide exactly one of studentId or teacherId',
  });

export const unassignSchema = z
  .object({
    studentId: z.string().min(1).optional(),
    teacherId: z.string().min(1).optional(),
  })
  .refine((v) => !!v.studentId !== !!v.teacherId, {
    message: 'Provide exactly one of studentId or teacherId',
  });

// ---------------------------------------------------------------------------
// Transport challans & payments
// ---------------------------------------------------------------------------

const pktDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
const yearMonth = {
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
};

/**
 * "all" is what an unset dropdown sends. Letting it through would filter for an
 * id of literally "all" and quietly match nothing.
 */
const idFilter = z
  .string()
  .optional()
  .transform((v) => (v && v !== 'all' ? v : undefined));

const riderKind = z.enum(['all', 'students', 'staff']).default('all');

export const transportPreviewQuerySchema = z.object({
  ...yearMonth,
  routeId: idFilter,
  kind: riderKind,
});

export const generateTransportChallansSchema = z.object({
  ...yearMonth,
  dueDate: pktDate,
  routeIds: z.array(z.string().min(1)).max(200).optional(),
  kind: riderKind,
  /** Riders unticked in the preview, as "student:<id>" / "staff:<id>". */
  excludeRiders: z.array(z.string().regex(/^(student|staff):.+$/)).max(2000).optional(),
  /**
   * Bill ONLY these riders (same key format). Used to raise a challan for one
   * or a few people — a late joiner, or someone whose challan was deleted to
   * be made again — without touching anyone else on the route.
   */
  onlyRiders: z.array(z.string().regex(/^(student|staff):.+$/)).min(1, 'Choose at least one person').max(2000).optional(),
});

export const listTransportChallansQuerySchema = z.object({
  year: z.union([z.coerce.number().int(), z.literal('all')]).optional(),
  month: z.union([z.coerce.number().int().min(1).max(12), z.literal('all')]).optional(),
  routeId: idFilter,
  kind: riderKind,
  /** `outstanding` = anything with money still owed (unpaid, partial, overdue). */
  status: z.enum(['all', 'outstanding', 'UNPAID', 'PARTIAL', 'PAID', 'OVERDUE', 'WAIVED']).default('all'),
  search: z.string().trim().max(120).optional(),
});

export const patchTransportChallanSchema = z
  .object({
    baseAmount: moneyInput({ min: 0 }).optional(),
    discount: moneyInput({ min: 0 }).optional(),
    lateFee: moneyInput({ min: 0 }).optional(),
    dueDate: pktDate.optional(),
    note: z.string().trim().max(300).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

/**
 * SALARY_DEDUCTION is deliberately not accepted here: it only describes fares
 * taken from pay before transport was billed on its own, and payroll no longer
 * does that. Money handed over at the office is one of these.
 */
export const recordTransportPaymentSchema = z.object({
  challanId: z.string().min(1),
  amount: moneyInput({ min: 0.01 }),
  paymentDate: pktDate,
  method: z.enum(['CASH', 'BANK_TRANSFER', 'CHEQUE', 'OTHER']),
  note: z.string().trim().max(300).nullable().optional(),
});

/** "They paid at the counter" for several challans at once — each gets a real payment for what it still owes. */
export const markTransportPaidSchema = z.object({
  challanIds: z.array(z.string().min(1)).min(1, 'Select at least one challan').max(500),
  paymentDate: pktDate,
  method: z.enum(['CASH', 'BANK_TRANSFER', 'CHEQUE', 'OTHER']).default('CASH'),
  note: z.string().trim().max(300).nullable().optional(),
});

/**
 * Deleting destroys the receipt entirely, unlike a reversal which keeps it, so
 * the reason is mandatory and goes into the audit entry.
 */
export const deleteTransportPaymentSchema = z.object({
  reason: z.string().trim().min(3, 'A reason is required').max(300),
});

export const reverseTransportPaymentSchema = z.object({
  reason: z.string().trim().min(3, 'A reason is required').max(300),
});

export const listTransportPaymentsQuerySchema = z.object({
  from: pktDate.optional(),
  to: pktDate.optional(),
  routeId: idFilter,
  kind: riderKind,
  method: z.enum(['all', 'CASH', 'BANK_TRANSFER', 'CHEQUE', 'SALARY_DEDUCTION', 'OTHER']).default('all'),
  state: z.enum(['all', 'active', 'reversed']).default('all'),
  search: z.string().trim().max(120).optional(),
});

export const printIdsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, 'Select at least one challan').max(200, 'Print at most 200 at once'),
});

export type TransportPreviewQuery = z.infer<typeof transportPreviewQuerySchema>;
export type GenerateTransportChallansInput = z.infer<typeof generateTransportChallansSchema>;
export type ListTransportChallansQuery = z.infer<typeof listTransportChallansQuerySchema>;
export type PatchTransportChallanInput = z.infer<typeof patchTransportChallanSchema>;
export type RecordTransportPaymentInput = z.infer<typeof recordTransportPaymentSchema>;
export type MarkTransportPaidInput = z.infer<typeof markTransportPaidSchema>;
export type ListTransportPaymentsQuery = z.infer<typeof listTransportPaymentsQuerySchema>;

export type CreateRouteInput = z.infer<typeof createRouteSchema>;
export type UpdateRouteInput = z.infer<typeof updateRouteSchema>;
export type AssignInput = z.infer<typeof assignSchema>;
export type UnassignInput = z.infer<typeof unassignSchema>;
