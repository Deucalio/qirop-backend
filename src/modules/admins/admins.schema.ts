import { z } from 'zod';
import { Gender, PermissionModule, UserStatus } from '@prisma/client';

const cnicRegex = /^\d{5}-\d{7}-\d$/;

/**
 * Employment details for a system user who is also a real employee. Supplying
 * this creates their staff profile, which is what puts them on the payroll and
 * lets their children's fees be deducted from their salary. Omit it for a
 * login-only account (an auditor, say) that is never paid.
 */
export const staffProfileSchema = z.object({
  gender: z.nativeEnum(Gender),
  fatherName: z.string().min(1, "Father's/mother's name is required").max(150),
  joiningDate: z.coerce.date(),
  // Optional: an owner or unpaid office-holder can hold a staff record with no
  // salary. 0 simply means nothing is disbursed to them.
  salary: z.coerce.number().min(0, 'Salary cannot be negative').optional().default(0),
  employeeId: z.string().max(50).optional(),
  qualification: z.string().max(255).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  parentCnic: z.string().max(20).nullable().optional(),
});

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
  staffProfile: staffProfileSchema.optional(),
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
export type StaffProfileInput = z.infer<typeof staffProfileSchema>;
export type CreateAdminInput = z.infer<typeof createAdminSchema>;
export type ListAdminsQuery = z.infer<typeof listAdminsQuerySchema>;
