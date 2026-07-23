import { z } from 'zod';

const MAX_MONEY = 99_999_999.99;
const moneyInput = (opts: { min?: number } = {}) =>
  z.union([z.number(), z.string()]).transform((v, ctx) => {
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    if (!Number.isFinite(n)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid amount' });
      return z.NEVER;
    }
    if (n < (opts.min ?? 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Amount cannot be less than ${opts.min ?? 0}` });
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

const yearMonth = {
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
};

export const generateSalariesSchema = z.object({
  ...yearMonth,
  teacherIds: z.array(z.string().min(1)).max(2000).optional(),
});

export const updateSalarySchema = z
  .object({
    allowances: moneyInput().optional(),
    deductions: moneyInput().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const salaryStatusSchema = z.object({
  status: z.enum(['PENDING', 'PAID']),
  paidDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional(),
});

export const listSalariesQuerySchema = z.object({
  year: z.coerce.number().int().optional(),
  month: z.coerce.number().int().optional(),
  status: z.enum(['PENDING', 'PAID']).optional(),
});

export type GenerateSalariesInput = z.infer<typeof generateSalariesSchema>;
export type UpdateSalaryInput = z.infer<typeof updateSalarySchema>;
export type SalaryStatusInput = z.infer<typeof salaryStatusSchema>;
export type ListSalariesQuery = z.infer<typeof listSalariesQuerySchema>;
