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
  monthlyFee: moneyInput({ min: 0 }),
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

export type CreateRouteInput = z.infer<typeof createRouteSchema>;
export type UpdateRouteInput = z.infer<typeof updateRouteSchema>;
export type AssignInput = z.infer<typeof assignSchema>;
export type UnassignInput = z.infer<typeof unassignSchema>;
