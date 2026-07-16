import { z } from 'zod';

const optionalEmail = z
  .union([z.string().email('Invalid email address'), z.literal('')])
  .nullable()
  .optional();

export const updateSchoolSchema = z.object({
  name: z.string().min(1, 'School name is required').max(200),
  address: z.string().max(500).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  email: optionalEmail,
  academicYear: z.string().min(1, 'Academic year is required').max(50),
});

// Settings is a free-form JSON blob (notification toggles, general configs).
export const updateSettingsSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
});

export type UpdateSchoolInput = z.infer<typeof updateSchoolSchema>;
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
