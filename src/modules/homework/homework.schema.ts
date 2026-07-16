import { z } from 'zod';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
const boolish = z
  .union([z.boolean(), z.literal('true'), z.literal('false')])
  .optional()
  .transform((v) => v === true || v === 'true');

export const createHomeworkSchema = z.object({
  sectionId: z.string().min(1, 'sectionId is required'),
  subjectId: z.string().min(1, 'subjectId is required'),
  title: z.string().min(1, 'Title is required').max(200),
  description: z.string().min(1, 'Description is required').max(5000),
  dueDate: z.coerce.date(),
});

export const updateHomeworkSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().min(1).max(5000).optional(),
    dueDate: z.coerce.date().optional(),
    clearAttachment: boolish,
  })
  .refine(
    (v) => v.title !== undefined || v.description !== undefined || v.dueDate !== undefined || v.clearAttachment,
    { message: 'Nothing to update' },
  );

export const teacherHomeworkQuerySchema = z.object({
  sectionId: z.string().optional(),
  subjectId: z.string().optional(),
  from: dateStr,
  to: dateStr,
});

export const adminHomeworkQuerySchema = z.object({
  classId: z.string().optional(),
  sectionId: z.string().optional(),
  subjectId: z.string().optional(),
  from: dateStr,
  to: dateStr,
});

export const childHomeworkQuerySchema = z.object({ from: dateStr, to: dateStr });

export type CreateHomeworkInput = z.infer<typeof createHomeworkSchema>;
export type UpdateHomeworkInput = z.infer<typeof updateHomeworkSchema>;
