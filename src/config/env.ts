import 'dotenv/config';
import { z } from 'zod';

/**
 * Centralised, validated environment. Import `env` anywhere instead of reading
 * `process.env` directly so we get a single typed source of truth.
 */
const envSchema = z.object({
  // Validated loosely — the placeholder <password> can break the strict URL parser.
  DATABASE_URL: z.string().startsWith('postgres', 'DATABASE_URL must be a postgres connection string'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

  CLIENT_ORIGIN: z.string().url().default('http://localhost:5173'),
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  SUPERADMIN_CNIC: z.string().default('00000-0000000-0'),
  SUPERADMIN_PASSWORD: z.string().default('ChangeMe#123'),
  SUPERADMIN_NAME: z.string().default('School Owner'),

  // External FileStore service (token is server-side only).
  FILESTORE_URL: z.string().url().default('https://file-upload.nakson.services'),
  FILESTORE_TOKEN: z.string().default(''),
  FILESTORE_APP_ID: z.string().default(''),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment variables:\n', JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
