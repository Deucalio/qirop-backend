import { z } from 'zod';
import { UserStatus } from '@prisma/client';

const cnicRegex = /^\d{5}-\d{7}-\d$/;

export const createParentSchema = z.object({
  cnic: z.string().regex(cnicRegex, 'CNIC must be in the format XXXXX-XXXXXXX-X'),
  fullName: z.string().min(1, 'Full name is required').max(150),
  phone: z.string().max(50).nullable().optional(),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  occupation: z.string().max(150).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
});

export const updateParentSchema = z
  .object({
    fullName: z.string().min(1).max(150).optional(),
    phone: z.string().max(50).nullable().optional(),
    occupation: z.string().max(150).nullable().optional(),
    address: z.string().max(500).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const parentStatusSchema = z.object({ status: z.nativeEnum(UserStatus) });

export const resetPasswordSchema = z.object({
  newPassword: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

export const listParentsQuerySchema = z.object({
  status: z.nativeEnum(UserStatus).optional(),
  search: z.string().trim().max(150).optional(),
});

export type CreateParentInput = z.infer<typeof createParentSchema>;
export type UpdateParentInput = z.infer<typeof updateParentSchema>;
export type ListParentsQuery = z.infer<typeof listParentsQuerySchema>;
