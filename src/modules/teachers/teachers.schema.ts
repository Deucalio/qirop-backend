import { z } from 'zod';
import { Gender, MarkingType, QualificationLevel, UserStatus } from '@prisma/client';

const cnicRegex = /^\d{5}-\d{7}-\d$/;

/** One academic milestone (Matric / Inter / Bachelor / Masters). */
const qualificationSchema = z.object({
  level: z.nativeEnum(QualificationLevel),
  institution: z.string().min(1, 'Board / university is required').max(200),
  passingYear: z.coerce.number().int().min(1950).max(2100),
  marks: z.string().max(50).nullable().optional(),
  grade: z.string().max(50).nullable().optional(),
  // Structured grading
  markingType: z.nativeEnum(MarkingType).default('TEXT'),
  obtainedMarks: z.coerce.number().nonnegative().nullable().optional(),
  totalMarks: z.coerce.number().positive().nullable().optional(),
});

const qualificationsArraySchema = z
  .array(qualificationSchema)
  .max(4)
  .refine((arr) => new Set(arr.map((q) => q.level)).size === arr.length, {
    message: 'Each qualification level may appear only once',
  });

export const createTeacherSchema = z.object({
  cnic: z.string().regex(cnicRegex, 'CNIC must be in the format XXXXX-XXXXXXX-X'),
  fullName: z.string().min(1, 'Full name is required').max(150),
  phone: z.string().max(50).nullable().optional(),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  employeeId: z.string().min(1, 'Employee ID is required').max(50),
  gender: z.nativeEnum(Gender),
  qualification: z.string().max(200).nullable().optional(),
  qualifications: qualificationsArraySchema.optional(),
  address: z.string().max(500).nullable().optional(),
  joiningDate: z.coerce.date(),
  salary: z.coerce.number().nonnegative('Salary must be zero or more'),
  fatherName: z.string().min(1, 'Father / mother name is required').max(150),
  parentCnic: z.string().regex(cnicRegex, 'Parent CNIC must be in the format XXXXX-XXXXXXX-X').optional().or(z.literal('')),
  // Transport route this teacher commutes on (deducted from their salary).
  transportRouteId: z.string().min(1).nullable().optional(),
});

export const updateTeacherSchema = z
  .object({
    fullName: z.string().min(1).max(150).optional(),
    phone: z.string().max(50).nullable().optional(),
    employeeId: z.string().min(1).max(50).optional(),
    gender: z.nativeEnum(Gender).optional(),
    qualification: z.string().max(200).nullable().optional(),
    qualifications: qualificationsArraySchema.optional(),
    address: z.string().max(500).nullable().optional(),
    joiningDate: z.coerce.date().optional(),
    salary: z.coerce.number().nonnegative().optional(),
    fatherName: z.string().min(1).max(150).optional(),
    parentCnic: z.string().regex(cnicRegex).nullable().optional().or(z.literal('')),
    transportRouteId: z.string().min(1).nullable().optional(),
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

/** ?year=&month= for the month-scoped attendance snapshot (defaults to the current PKT month). */
export const attendanceMonthQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
});

export type CreateTeacherInput = z.infer<typeof createTeacherSchema>;
export type UpdateTeacherInput = z.infer<typeof updateTeacherSchema>;
export type ListTeachersQuery = z.infer<typeof listTeachersQuerySchema>;
