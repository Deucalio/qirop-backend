import { z } from 'zod';
import { PaymentMethod } from '@prisma/client';

/**
 * A money input: accept a number or numeric string, reject negatives, NaN and
 * absurd values, and hand a canonical string to the service (which wraps it in a
 * Decimal). Max 99,999,999.99 fits Decimal(10,2).
 */
const MAX_MONEY = 99_999_999.99;
const moneyInput = (opts: { min?: number } = {}) =>
  z
    .union([z.number(), z.string()])
    .transform((v, ctx) => {
      const n = typeof v === 'number' ? v : Number(v.trim());
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
      // Reject more than 2 decimal places.
      if (Math.round(n * 100) / 100 !== n) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Amount can have at most 2 decimal places' });
        return z.NEVER;
      }
      return n.toFixed(2);
    });

const yearMonth = {
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
};
const pktDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

// ---- Fee structure & discounts ----
export const setFeeStructureSchema = z.object({
  monthlyFee: moneyInput(),
  admissionFee: moneyInput().optional(),
});

export const setDiscountSchema = z.object({
  feeDiscount: moneyInput(),
  discountNote: z.string().trim().max(300).nullable().optional(),
});

// ---- Challan generation ----
export const generateChallansSchema = z.object({
  ...yearMonth,
  dueDate: pktDate,
  classId: z.string().min(1).optional(),
  sectionId: z.string().min(1).optional(),
  studentIds: z.array(z.string().min(1)).max(2000).optional(),
  // Bulk exam fee: charged once to every student in the batch.
  examFee: moneyInput({ min: 0 }).optional(),
  examLabel: z.string().trim().max(80).optional(),
  // Bulk "other" fee (e.g. annual charges, stationery): charged once to everyone.
  otherFee: moneyInput({ min: 0 }).optional(),
  otherLabel: z.string().trim().max(80).optional(),
  // Extra discount % applied to students whose parent is a teacher (staff perk).
  staffChildDiscountPercent: z.coerce.number().min(0).max(100).optional(),
});

// ---- Challan edits ----
export const patchChallanSchema = z
  .object({
    lateFee: moneyInput().optional(),
    discount: moneyInput().optional(),
    dueDate: pktDate.optional(),
    addItem: z
      .object({
        type: z.enum(['TUITION', 'TRANSPORT', 'ADMISSION', 'EXAM', 'OTHER']),
        label: z.string().trim().min(1).max(80),
        amount: moneyInput({ min: 0 }),
      })
      .optional(),
    removeItemId: z.string().min(1).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

// ---- Payments ----
export const recordPaymentSchema = z.object({
  studentId: z.string().min(1),
  amount: moneyInput({ min: 0.01 }),
  paymentDate: pktDate,
  method: z.nativeEnum(PaymentMethod),
  note: z.string().trim().max(300).nullable().optional(),
  // Explicit allocation (optional); otherwise auto FIFO.
  allocations: z
    .array(z.object({ challanId: z.string().min(1), amountApplied: moneyInput({ min: 0.01 }) }))
    .min(1)
    .optional(),
});

/** Bulk "they paid at the counter" — records a real payment per challan. */
export const markPaidSchema = z.object({
  challanIds: z.array(z.string().min(1)).min(1, 'Select at least one challan').max(500),
  paymentDate: pktDate,
  method: z.nativeEnum(PaymentMethod).default(PaymentMethod.CASH),
  note: z.string().trim().max(300).nullable().optional(),
});

export const reversePaymentSchema = z.object({
  reason: z.string().trim().min(3, 'A reason is required').max(300),
});

// ---- Query params ----
export const listChallansQuerySchema = z.object({
  year: z.coerce.number().int().optional(),
  month: z.coerce.number().int().optional(),
  classId: z.string().optional(),
  sectionId: z.string().optional(),
  status: z.enum(['UNPAID', 'PARTIAL', 'PAID', 'OVERDUE']).optional(),
  search: z.string().trim().max(150).optional(),
});

export const listPaymentsQuerySchema = z.object({
  studentId: z.string().optional(),
  from: pktDate.optional(),
  to: pktDate.optional(),
});

export type GenerateChallansInput = z.infer<typeof generateChallansSchema>;
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;
export type PatchChallanInput = z.infer<typeof patchChallanSchema>;
export type ListChallansQuery = z.infer<typeof listChallansQuerySchema>;
