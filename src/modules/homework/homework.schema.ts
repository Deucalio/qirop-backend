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

/**
 * "all" is what the filter bar sends for an unset dropdown. Letting that string
 * reach Prisma would match an id of literally "all" and quietly return nothing,
 * so it is folded to undefined here rather than guarded at every call site.
 */
const idFilter = z
  .string()
  .optional()
  .transform((v) => (v && v !== 'all' ? v : undefined));

/** Filters shared by the admin and teacher lists. */
const listQueryBase = {
  search: z.string().trim().max(120).optional(),
  classId: idFilter,
  sectionId: idFilter,
  subjectId: idFilter,
  /** Against today in PKT: due today counts as upcoming, not overdue. */
  status: z.enum(['all', 'upcoming', 'overdue']).default('all'),
  attachment: z.enum(['all', 'with', 'without']).default('all'),
  from: dateStr,
  to: dateStr,
  sort: z.enum(['dueDate_desc', 'dueDate_asc', 'createdAt_desc', 'createdAt_asc']).default('dueDate_desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(12),
};

export const teacherHomeworkQuerySchema = z.object(listQueryBase);

export const adminHomeworkQuerySchema = z.object({
  ...listQueryBase,
  teacherId: idFilter,
});

export type HomeworkListQuery = z.infer<typeof adminHomeworkQuerySchema>;

export const childHomeworkQuerySchema = z.object({
  from: dateStr,
  to: dateStr,
  status: z.enum(['all', 'upcoming', 'overdue']).default('all'),
});

export type CreateHomeworkInput = z.infer<typeof createHomeworkSchema>;
export type UpdateHomeworkInput = z.infer<typeof updateHomeworkSchema>;
