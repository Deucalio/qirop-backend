import type { NextFunction, Request, Response } from 'express';

/** Slower than this is worth a line in the journal. */
const SLOW_MS = 2_000;

/**
 * One journal line for every request worth looking at — and nothing for the
 * thousands that went fine, so `journalctl` stays readable:
 *
 *   - FAILED    any 5xx answer
 *   - SLOW      answered, but took longer than SLOW_MS
 *   - ABORTED   the caller gave up before the answer was sent. Behind Vercel's
 *               /api rewrite this is what a 502 looks like from this side:
 *               Vercel stops waiting at 30s and drops the connection.
 *
 * Set LOG_ALL_REQUESTS=1 in .env (and restart) to log every request while
 * chasing a problem; leave it unset otherwise.
 *
 *   journalctl -u akm-backend.service -f
 *   journalctl -u akm-backend.service --since "1 hour ago" | grep -E "ABORTED|FAILED|SLOW"
 */
export function requestLog(req: Request, res: Response, next: NextFunction): void {
  const started = process.hrtime.bigint();
  const logAll = process.env.LOG_ALL_REQUESTS === '1';
  let done = false;

  const elapsed = () => Number((process.hrtime.bigint() - started) / 1_000_000n);
  const line = (tag: string, extra = '') =>
    // eslint-disable-next-line no-console
    console.log(`[${tag}] ${req.method} ${req.originalUrl} ${extra}${elapsed()}ms ip=${req.ip ?? '-'}`);

  res.on('finish', () => {
    done = true;
    const ms = elapsed();
    if (res.statusCode >= 500) line('FAILED', `${res.statusCode} `);
    else if (ms >= SLOW_MS) line('SLOW', `${res.statusCode} `);
    else if (logAll) line('OK', `${res.statusCode} `);
  });

  // 'close' without 'finish' = the connection went away before we answered.
  res.on('close', () => {
    if (!done) line('ABORTED', 'client closed before response · ');
  });

  next();
}
