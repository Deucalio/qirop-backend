import { z } from 'zod';
import { Gender, UserStatus } from '@prisma/client';

const cnicRegex = /^\d{5}-\d{7}-\d$/;

const inlineParentSchema = z.object({
  cnic: z.string().regex(cnicRegex, 'CNIC must be in the format XXXXX-XXXXXXX-X'),
  fullName: z.string().min(1, 'Parent full name is required').max(150),
  phone: z.string().max(50).nullable().optional(),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  occupation: z.string().max(150).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
});

export const createStudentSchema = z
  .object({
    admissionNo: z.string().min(1, 'Admission number is required').max(50),
    rollNo: z.string().max(50).nullable().optional(),
    firstName: z.string().min(1, 'First name is required').max(100),
    lastName: z.string().min(1, 'Last name is required').max(100),
    gender: z.nativeEnum(Gender),
    dob: z.coerce.date().nullable().optional(),
    admissionDate: z.coerce.date(),
    sectionId: z.string().min(1, 'Section is required'),
    parentId: z.string().min(1).optional(),
    parent: inlineParentSchema.optional(),
  })
  .refine((v) => Boolean(v.parentId) || Boolean(v.parent), {
    message: 'Provide either parentId or inline parent details',
    path: ['parentId'],
  });

export const updateStudentSchema = z
  .object({
    admissionNo: z.string().min(1).max(50).optional(),
    rollNo: z.string().max(50).nullable().optional(),
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
    gender: z.nativeEnum(Gender).optional(),
    dob: z.coerce.date().nullable().optional(),
    admissionDate: z.coerce.date().optional(),
    sectionId: z.string().min(1).optional(), // section transfer
    parentId: z.string().min(1).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const studentStatusSchema = z.object({ status: z.nativeEnum(UserStatus) });

export const listStudentsQuerySchema = z.object({
  classId: z.string().optional(),
  sectionId: z.string().optional(),
  status: z.nativeEnum(UserStatus).optional(),
  search: z.string().trim().max(150).optional(),
});

export type CreateStudentInput = z.infer<typeof createStudentSchema>;
export type UpdateStudentInput = z.infer<typeof updateStudentSchema>;
export type ListStudentsQuery = z.infer<typeof listStudentsQuerySchema>;
