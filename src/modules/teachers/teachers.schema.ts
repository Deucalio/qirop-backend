import { z } from 'zod';
import { UserStatus } from '@prisma/client';

const cnicRegex = /^\d{5}-\d{7}-\d$/;

export const createTeacherSchema = z.object({
  cnic: z.string().regex(cnicRegex, 'CNIC must be in the format XXXXX-XXXXXXX-X'),
  fullName: z.string().min(1, 'Full name is required').max(150),
  phone: z.string().max(50).nullable().optional(),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  employeeId: z.string().min(1, 'Employee ID is required').max(50),
  qualification: z.string().max(200).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  joiningDate: z.coerce.date(),
  salary: z.coerce.number().nonnegative('Salary must be zero or more'),
});

export const updateTeacherSchema = z
  .object({
    fullName: z.string().min(1).max(150).optional(),
    phone: z.string().max(50).nullable().optional(),
    employeeId: z.string().min(1).max(50).optional(),
    qualification: z.string().max(200).nullable().optional(),
    address: z.string().max(500).nullable().optional(),
    joiningDate: z.coerce.date().optional(),
    salary: z.coerce.number().nonnegative().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const teacherStatusSchema = z.object({
  status: z.nativeEnum(UserStatus),
  force: z.boolean().optional().default(false),
});

export const resetPasswordSchema = z.object({
  newPassword: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

export const listTeachersQuerySchema = z.object({
  status: z.nativeEnum(UserStatus).optional(),
  search: z.string().trim().max(150).optional(),
});

export type CreateTeacherInput = z.infer<typeof createTeacherSchema>;
export type UpdateTeacherInput = z.infer<typeof updateTeacherSchema>;
export type ListTeachersQuery = z.infer<typeof listTeachersQuerySchema>;
