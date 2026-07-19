import { z } from 'zod';
import { DayOfWeek } from '@prisma/client';

/** Set one grid cell; subjectId null clears it. */
export const setSlotSchema = z.object({
  day: z.nativeEnum(DayOfWeek),
  periodIndex: z.coerce.number().int().min(1).max(12),
  subjectId: z.string().min(1).nullable(),
});

const pktDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

/** School-wide period/break timings, per weekday. Values are re-clamped server-side. */
const dayConfigSchema = z.object({
  open: z.boolean(),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'start must be HH:MM'),
  periods: z.array(z.coerce.number().int().min(5).max(240)).min(1, 'A day needs at least one period').max(14),
  breakAfter: z.coerce.number().int().min(0).max(14),
  breakMinutes: z.coerce.number().int().min(5).max(240),
  breakLabel: z.string().trim().min(1).max(40),
});

export const saveTimetableConfigSchema = z.object({
  config: z.object({
    MON: dayConfigSchema,
    TUE: dayConfigSchema,
    WED: dayConfigSchema,
    THU: dayConfigSchema,
    FRI: dayConfigSchema,
    SAT: dayConfigSchema,
  }),
  /** Preview the impact (how many scheduled periods would be dropped) without saving. */
  dryRun: z.boolean().optional(),
});

/** How long the weekly pattern repeats; `until` null = no end date. */
export const setValiditySchema = z.object({
  from: pktDateString,
  until: pktDateString.nullable(),
});

/** The school currently records only Present / Absent. */
export const markPeriodAttendanceSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  records: z
    .array(
      z.object({
        periodIndex: z.coerce.number().int().min(1).max(12),
        status: z.enum(['PRESENT', 'ABSENT']),
      }),
    )
    .min(1, 'Mark at least one period'),
});

export type SetSlotInput = z.infer<typeof setSlotSchema>;
export type SetValidityInput = z.infer<typeof setValiditySchema>;
export type SaveTimetableConfigInput = z.infer<typeof saveTimetableConfigSchema>;
export type MarkPeriodAttendanceInput = z.infer<typeof markPeriodAttendanceSchema>;
