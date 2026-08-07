import type { CookieOptions, Request, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import * as authService from './auth.service';
import { AUTH_COOKIE, AUTH_COOKIE_MAX_AGE } from './auth.constants';
import { cookieSecure } from '../../config/env';
import { Unauthorized } from '../../utils/apiResponse';
import { logAudit } from '../audit/audit.service';
import { prisma } from '../../config/prisma';

const cookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: cookieSecure, // HTTPS-only unless COOKIE_SECURE=false (no-TLS deployments)
  maxAge: AUTH_COOKIE_MAX_AGE,
  path: '/',
};

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { cnic, password } = req.body as { cnic: string; password: string };
  try {
    const { token, user } = await authService.login(cnic, password);
    res.cookie(AUTH_COOKIE, token, cookieOptions);

    // Audited from the controller so `req` supplies the IP and user agent —
    // for a sign-in record those are most of the value.
    void logAudit(req, {
      actorId: user.id,
      actorName: user.fullName,
      actorRole: user.role,
      action: 'LOGIN',
      module: 'AUTH',
      targetType: 'User',
      targetId: user.id,
      targetLabel: user.fullName,
      details: `${user.fullName} signed in`,
    });

    res.json(user);
  } catch (err) {
    // Failed attempts matter more than successful ones: repeated failures on
    // one CNIC are the only signal of someone trying to guess a password.
    // The CNIC is recorded, never the password that was tried.
    void recordFailedLogin(req, cnic, err);
    next(err);
  }
}

/** Log a rejected sign-in, attributing it to the account when the CNIC is real. */
async function recordFailedLogin(req: Request, cnic: string, err: unknown): Promise<void> {
  try {
    const reason = (err as { code?: string })?.code ?? 'INVALID_CREDENTIALS';
    const user = cnic
      ? await prisma.user.findUnique({ where: { cnic }, select: { id: true, fullName: true, role: true } })
      : null;

    await logAudit(req, {
      actorId: user?.id ?? null,
      actorName: user?.fullName ?? 'Unknown',
      actorRole: user?.role ?? Role.ADMIN,
      action: 'LOGIN_FAILED',
      module: 'AUTH',
      targetType: 'User',
      targetId: user?.id ?? null,
      targetLabel: user?.fullName ?? `CNIC ${cnic || 'not supplied'}`,
      details: user
        ? `Failed sign-in for ${user.fullName} (${reason})`
        : `Failed sign-in for an unrecognised CNIC (${reason})`,
    });
  } catch {
    // Never let an audit failure mask the original auth error.
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

    // The passwords themselves are never recorded — only that a change happened.
    void logAudit(req, {
      action: 'PASSWORD_CHANGE',
      module: 'AUTH',
      targetType: 'User',
      targetId: req.user.userId,
      targetLabel: 'Own account',
      details: 'Changed their own password',
    });

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
    const previousRole = req.user.role;
    const { token, user } = await authService.switchRole(req.user.userId, role);
    res.cookie(AUTH_COOKIE, token, cookieOptions);

    void logAudit(req, {
      actorId: user.id,
      actorName: user.fullName,
      action: 'ROLE_SWITCH',
      module: 'AUTH',
      targetType: 'User',
      targetId: user.id,
      targetLabel: user.fullName,
      details: `Switched from ${previousRole} to ${role} view`,
      changes: { role: { before: previousRole, after: role } },
    });

    res.json(user);
  } catch (err) {
    next(err);
  }
}
