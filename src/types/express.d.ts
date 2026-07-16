import type { Role } from '@prisma/client';

// Augment Express's Request with the authenticated user set by requireAuth.
declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        role: Role;
      };
    }
  }
}

export {};
