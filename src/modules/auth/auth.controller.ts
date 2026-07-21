import type { CookieOptions, Request, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import * as authService from './auth.service';
import { AUTH_COOKIE, AUTH_COOKIE_MAX_AGE } from './auth.constants';
import { cookieSecure } from '../../config/env';
import { Unauthorized } from '../../utils/apiResponse';

const cookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: cookieSecure, // HTTPS-only unless COOKIE_SECURE=false (no-TLS deployments)
  maxAge: AUTH_COOKIE_MAX_AGE,
  path: '/',
};

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { cnic, password } = req.body as { cnic: string; password: string };
    const { token, user } = await authService.login(cnic, password);
    res.cookie(AUTH_COOKIE, token, cookieOptions);
    res.json(user);
  } catch (err) {
    next(err);
  }
}

export function logout(_req: Request, res: Response): void {
  res.clearCookie(AUTH_COOKIE, { ...cookieOptions, maxAge: undefined });
  res.json({ message: 'Logged out' });
}

export async function me(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw Unauthorized();
    }
    const user = await authService.getMe(req.user.userId);
    res.json(user);
  } catch (err) {
    next(err);
  }
}

export async function changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw Unauthorized();
    }
    const { currentPassword, newPassword } = req.body as {
      currentPassword: string;
      newPassword: string;
    };
    await authService.changePassword(req.user.userId, currentPassword, newPassword);
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    next(err);
  }
}

export async function switchRole(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw Unauthorized();
    }
    const { role } = req.body as { role: Role };
    const { token, user } = await authService.switchRole(req.user.userId, role);
    res.cookie(AUTH_COOKIE, token, cookieOptions);
    res.json(user);
  } catch (err) {
    next(err);
  }
}
