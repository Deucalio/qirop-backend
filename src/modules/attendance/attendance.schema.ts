import { z } from 'zod';
import { AttendanceStatus } from '@prisma/client';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be in YYYY-MM-DD format');

export const dateQuerySchema = z.object({ date: dateStr.optional() });

export const monthQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
});

export const trendQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(60).default(7) });

export const overallSummaryQuerySchema = z.object({
  startDate: dateStr.optional(),
  endDate: dateStr.optional(),
});

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

/**
 * Batch teacher marking, used by the monthly sheet's Save.
 *
 * This route previously read `req.body.records` with no validation at all — any
 * shape, any date, any id went straight into an upsert loop.
 */
export const markTeachersBatchSchema = z.object({
  records: z
    .array(
      z.object({
        teacherId: z.string().min(1),
        date: dateStr,
        // null clears the mark — an admin undoing a mis-click must be able to
        // put a cell back to blank, not just to a different status.
        status: z.nativeEnum(AttendanceStatus).nullable(),
      }),
    )
    .min(1, 'At least one record is required')
    .max(500, 'Too many records in one request'),
});

export type MarkSectionInput = z.infer<typeof markSectionSchema>;

export const createHolidaySchema = z.object({
  date: dateStr,
  title: z.string().trim().min(1, 'A name is required').max(120),
});
