import { z } from 'zod';
import { AttendanceStatus } from '@prisma/client';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be in YYYY-MM-DD format');

export const dateQuerySchema = z.object({ date: dateStr.optional() });

export const monthQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
});

export const trendQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(60).default(7) });

export const adminAttendanceQuerySchema = z.object({
  date: dateStr.optional(),
  classId: z.string().optional(),
  sectionId: z.string().optional(),
});

export const markSectionSchema = z.object({
  date: dateStr,
  records: z
    .array(
      z.object({
        studentId: z.string().min(1),
        status: z.nativeEnum(AttendanceStatus),
        note: z.string().max(300).nullable().optional(),
      }),
    )
    .min(1, 'At least one record is required'),
});

export const setTeacherAttendanceSchema = z.object({
  date: dateStr,
  status: z.nativeEnum(AttendanceStatus),
  checkInTime: z.string().datetime().nullable().optional(),
});

export type MarkSectionInput = z.infer<typeof markSectionSchema>;
