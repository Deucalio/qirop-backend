import { z } from 'zod';

// ---- Classes ----
export const createClassSchema = z.object({
  name: z.string().min(1, 'Class name is required').max(100),
  order: z.number().int().min(0).max(1000),
});

export const updateClassSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    order: z.number().int().min(0).max(1000).optional(),
  })
  .refine((v) => v.name !== undefined || v.order !== undefined, { message: 'Nothing to update' });

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

export const updateSubjectSchema = z.object({
  name: z.string().min(1, 'Subject name is required').max(100),
});

// ---- Class ↔ Subject mapping ----
export const setClassSubjectsSchema = z.object({
  subjectIds: z.array(z.string().min(1)),
});
