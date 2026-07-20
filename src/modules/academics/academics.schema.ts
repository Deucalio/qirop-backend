import { z } from 'zod';

// ---- Classes ----
// `order` is derived automatically from the number in the class name.
export const createClassSchema = z.object({
  name: z.string().min(1, 'Class name is required').max(100),
  /** Optional section names; omit for a class that isn't split into sections. */
  sections: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
});

export const updateClassSchema = z.object({
  name: z.string().min(1, 'Class name is required').max(100),
});

// ---- Sections ----
export const createSectionSchema = z.object({
  name: z.string().min(1, 'Section name is required').max(50),
});

export const updateSectionSchema = z.object({
  name: z.string().min(1, 'Section name is required').max(50),
});

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
