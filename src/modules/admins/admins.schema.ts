import { z } from 'zod';
import { PermissionModule, UserStatus } from '@prisma/client';

const cnicRegex = /^\d{5}-\d{7}-\d$/;

export const permissionEntrySchema = z.object({
  module: z.nativeEnum(PermissionModule),
  canView: z.boolean(),
  canEdit: z.boolean(),
  canManage: z.boolean().optional().default(false),
});

export const createAdminSchema = z.object({
  cnic: z.string().regex(cnicRegex, 'CNIC must be in the format XXXXX-XXXXXXX-X'),
  fullName: z.string().min(1, 'Full name is required').max(150),
  designation: z.string().min(1, 'Designation is required').max(100),
  phone: z.string().min(1, 'Phone is required').max(50),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  permissions: z.array(permissionEntrySchema).default([]),
});

export const updateAdminSchema = z
  .object({
    fullName: z.string().min(1).max(150).optional(),
    designation: z.string().max(100).nullable().optional(),
    phone: z.string().max(50).nullable().optional(),
  })
  .refine((v) => v.fullName !== undefined || v.designation !== undefined || v.phone !== undefined, {
    message: 'Nothing to update',
  });

export const updatePermissionsSchema = z.object({
  permissions: z.array(permissionEntrySchema),
});

export const resetPasswordSchema = z.object({
  newPassword: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

export const updateStatusSchema = z.object({
  status: z.nativeEnum(UserStatus),
});

export const listAdminsQuerySchema = z.object({
  status: z.nativeEnum(UserStatus).optional(),
  search: z.string().trim().max(150).optional(),
});

export type PermissionEntry = z.infer<typeof permissionEntrySchema>;
export type CreateAdminInput = z.infer<typeof createAdminSchema>;
export type ListAdminsQuery = z.infer<typeof listAdminsQuerySchema>;
