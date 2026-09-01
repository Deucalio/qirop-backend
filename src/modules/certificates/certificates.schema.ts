import { z } from 'zod';
import { CertificateKind } from '@prisma/client';

/** Reuses the fees module's money shape: a plain decimal string, two places. */
const moneyInput = (opts: { min?: number } = {}) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => Number(v))
    .refine((n) => Number.isFinite(n), { message: 'Must be a number' })
    .refine((n) => n >= (opts.min ?? 0), { message: `Must be at least ${opts.min ?? 0}` })
    .transform((n) => n.toFixed(2));

export const setCertificateFeeSchema = z.object({
  amount: moneyInput({ min: 0 }),
  active: z.boolean().optional(),
});

export const recordIssueSchema = z.object({
  studentId: z.string().min(1),
  kind: z.nativeEnum(CertificateKind),
  /** Omitted uses the configured fee; 0 issues this one free. */
  amount: moneyInput({ min: 0 }).optional(),
  note: z.string().trim().max(300).nullable().optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
});
