/**
 * Date helpers for the school's timezone, Asia/Karachi (UTC+5, no DST).
 *
 * Attendance dates are stored as the **canonical UTC-midnight Date of the PKT
 * calendar day** (e.g. PKT 2026-07-08 → 2026-07-08T00:00:00.000Z). This keeps
 * one stable value per PKT day so uniqueness, grouping and display all agree,
 * and late-evening marking records the correct PKT day rather than the UTC one.
 */
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

/** Canonical UTC-midnight Date for the PKT calendar day of `input` (default: now). */
export function pktDay(input?: Date | string | number): Date {
  const base = input === undefined ? new Date() : new Date(input);
  const shifted = new Date(base.getTime() + PKT_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

/** 'YYYY-MM-DD' string for the PKT calendar day of `input`. */
export function pktDayString(input?: Date | string | number): string {
  return pktDay(input).toISOString().slice(0, 10);
}

/** Parse a 'YYYY-MM-DD' PKT calendar date to its canonical UTC-midnight Date. */
export function parsePktDay(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** True if `day` (a canonical PKT day) is after today (PKT). */
export function isFuturePktDay(day: Date): boolean {
  return day.getTime() > pktDay().getTime();
}

/** The N most recent PKT days (canonical dates), oldest → newest, ending today. */
export function lastNPktDays(n: number): Date[] {
  const today = pktDay();
  const days: Date[] = [];
  for (let i = n - 1; i >= 0; i--) {
    days.push(new Date(today.getTime() - i * 86_400_000));
  }
  return days;
}

/** First and last canonical PKT days of a given year/month (1-based month). */
export function pktMonthRange(year: number, month: number): { start: Date; endExclusive: Date } {
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    endExclusive: new Date(Date.UTC(year, month, 1)),
  };
}
