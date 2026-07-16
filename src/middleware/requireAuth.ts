import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwt';
import { Unauthorized } from '../utils/apiResponse';
import { AUTH_COOKIE } from '../modules/auth/auth.constants';

/**
 * Reads the httpOnly JWT cookie, verifies it, and attaches `req.user`.
 * Rejects with 401 when the cookie is missing or invalid.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = req.cookies?.[AUTH_COOKIE] as string | undefined;
  if (!token) {
    next(Unauthorized());
    return;
  }

  try {
    const payload = verifyToken(token);
    req.user = { userId: payload.userId, role: payload.role };
    next();
  } catch {
    next(Unauthorized('Invalid or expired session'));
  }
}
