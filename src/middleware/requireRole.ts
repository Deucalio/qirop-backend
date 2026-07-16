import type { Request, Response, NextFunction } from 'express';
import type { Role } from '@prisma/client';
import { Unauthorized, Forbidden } from '../utils/apiResponse';

/**
 * Allows the request only if the authenticated user's role is in `roles`.
 * Must run after requireAuth.
 */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(Unauthorized());
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(Forbidden());
      return;
    }
    next();
  };
}
