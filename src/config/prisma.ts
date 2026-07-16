import { PrismaClient } from '@prisma/client';
import { env } from './env';

/**
 * Single PrismaClient instance for the whole process. In dev with tsx watch we
 * reuse the instance across reloads to avoid exhausting the connection pool.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
