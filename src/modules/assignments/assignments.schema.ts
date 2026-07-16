import { z } from 'zod';

export const setClassTeacherSchema = z.object({
  teacherId: z.string().min(1).nullable(),
});

export const upsertTeachingAssignmentSchema = z.object({
  sectionId: z.string().min(1, 'sectionId is required'),
  subjectId: z.string().min(1, 'subjectId is required'),
  teacherId: z.string().min(1, 'teacherId is required'),
});

export const deleteTeachingAssignmentSchema = z.object({
  sectionId: z.string().min(1, 'sectionId is required'),
  subjectId: z.string().min(1, 'subjectId is required'),
});
