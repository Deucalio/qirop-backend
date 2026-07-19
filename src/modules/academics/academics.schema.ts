import { z } from 'zod';

// ---- Classes ----
// `order` is derived automatically from the number in the class name.
export const createClassSchema = z.object({
  name: z.string().min(1, 'Class name is required').max(100),
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

export const updateSubjectSchema = z.object({
  name: z.string().min(1, 'Subject name is required').max(100),
});

// ---- Class ↔ Subject mapping ----
export const setClassSubjectsSchema = z.object({
  subjectIds: z.array(z.string().min(1)),
});
