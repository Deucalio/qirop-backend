import { z } from 'zod';

// ---- Classes ----
// `order` is derived automatically from the number in the class name.
export const createClassSchema = z.object({
  name: z.string().min(1, 'Class name is required').max(100),
  /** Optional single-letter section names; omit if the class isn't split. */
  sections: z
    .array(
      z
        .string()
        .trim()
        .transform((v) => v.toUpperCase())
        .pipe(z.string().regex(/^[A-Z]$/, 'Sections must be a single letter from A to Z')),
    )
    .max(26)
    .optional(),
});

export const updateClassSchema = z.object({
  name: z.string().min(1, 'Class name is required').max(100),
});

// ---- Sections ----
/**
 * A section is a single letter (A, B, C…). The UI always renders it as
 * "Section A", so allowing free text produced "Section Section C".
 */
const sectionName = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(
    z
      .string()
      .length(1, 'Use a single letter, e.g. A')
      .regex(/^[A-Z]$/, 'Use a single letter from A to Z'),
  );

export const createSectionSchema = z.object({ name: sectionName });
export const updateSectionSchema = z.object({ name: sectionName });

// ---- Subjects ----
export const createSubjectSchema = z.object({
  name: z.string().min(1, 'Subject name is required').max(100),
});

export const updateSubjectSchema = z
  .object({
    name: z.string().min(1, 'Subject name is required').max(100).optional(),
    /** Hex colour like "#4f46e5"; null reverts to the automatic colour. */
    color: z.string().min(3).max(9).nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.color !== undefined, { message: 'Nothing to update' });

// ---- Class ↔ Subject mapping ----
export const setClassSubjectsSchema = z.object({
  subjectIds: z.array(z.string().min(1)),
});
