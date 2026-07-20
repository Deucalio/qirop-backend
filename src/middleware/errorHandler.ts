import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AppError } from '../utils/apiResponse';
import { isProduction } from '../config/env';

/** 404 for any unmatched route. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { message: `Route not found: ${req.method} ${req.originalUrl}`, code: 'NOT_FOUND' },
  });
}

/** Central error handler — always responds with `{ error: { message, code } }`. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    return;
  }

  if (err instanceof AppError) {
    res.status(err.status).json({
      error: {
        message: err.message,
        code: err.code,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
    return;
  }

  // Multer upload errors (duck-typed to avoid importing multer here).
  if (err && typeof err === 'object' && (err as { name?: string }).name === 'MulterError') {
    const code = (err as { code?: string }).code;
    const message =
      code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 2 MB)' : 'File upload failed';
    res.status(413).json({ error: { message, code: code ?? 'UPLOAD_ERROR' } });
    return;
  }

  if (err instanceof ZodError) {
    res.status(422).json({
      error: {
        message: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: err.flatten().fieldErrors,
      },
    });
    return;
  }

  // Connectivity/timeout problems are infrastructure faults, not bad requests —
  // they must not be reported as 400, and the message has to tell a non-technical
  // user what to do (school connections here drop regularly).
  const UNREACHABLE_DB_CODES = new Set(['P1000', 'P1001', 'P1002', 'P1008', 'P1017', 'P2024']);
  const isDbUnreachable =
    err instanceof Prisma.PrismaClientInitializationError ||
    (err instanceof Prisma.PrismaClientKnownRequestError && UNREACHABLE_DB_CODES.has(err.code));
  if (isDbUnreachable) {
    const code = err instanceof Prisma.PrismaClientKnownRequestError ? err.code : 'DB_INIT';
    // eslint-disable-next-line no-console
    console.error(`Database unreachable (${code}):`, err instanceof Error ? err.message : err);
    res.status(503).json({
      error: {
        message:
          'Cannot reach the school database right now. This is usually a temporary internet problem — wait a moment and try again. If it keeps happening, contact your system administrator.',
        code: 'DB_UNAVAILABLE',
      },
    });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res.status(409).json({
        error: { message: 'A record with this value already exists', code: 'UNIQUE_VIOLATION' },
      });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: { message: 'Record not found', code: 'NOT_FOUND' } });
      return;
    }
    if (err.code === 'P2003') {
      res.status(409).json({
        error: {
          message: 'This record is still linked to other records, so it cannot be changed or removed.',
          code: 'FOREIGN_KEY_VIOLATION',
        },
      });
      return;
    }
    // eslint-disable-next-line no-console
    console.error(`Prisma ${err.code}:`, err.message);
    res.status(400).json({ error: { message: 'The database rejected this request', code: err.code } });
    return;
  }

  // eslint-disable-next-line no-console
  console.error('Unhandled error:', err);
  const message = !isProduction && err instanceof Error ? err.message : 'Internal server error';
  res.status(500).json({ error: { message, code: 'INTERNAL_ERROR' } });
}
