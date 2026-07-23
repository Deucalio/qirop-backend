import { z } from 'zod';
import { ExpenseCategory, PayerType } from '@prisma/client';

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

const pktDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

const fundingItem = z.object({
  payerType: z.nativeEnum(PayerType),
  payerId: z.string().min(1).nullable().optional(),
  amount: moneyInput({ min: 0.01 }),
  remarks: z.string().trim().max(200).nullable().optional(),
});

export const createExpenseSchema = z.object({
  category: z.nativeEnum(ExpenseCategory),
  title: z.string().trim().min(1, 'Title is required').max(120),
  amount: moneyInput({ min: 0.01 }),
  date: pktDate,
  note: z.string().trim().max(500).nullable().optional(),
  funding: z.array(fundingItem).max(20).optional(),
});

export const updateExpenseSchema = createExpenseSchema.partial();

export const listExpensesQuerySchema = z.object({
  from: pktDate.optional(),
  to: pktDate.optional(),
  category: z.nativeEnum(ExpenseCategory).optional(),
  search: z.string().trim().max(150).optional(),
});

export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;
export type ListExpensesQuery = z.infer<typeof listExpensesQuerySchema>;
