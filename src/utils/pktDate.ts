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

/** 'hh:mm AM/PM' 12-hour formatted time string in PKT timezone. */
export function pktTime12HourString(input?: Date | string | number): string {
  if (!input) return '—';
  const base = new Date(input);
  if (isNaN(base.getTime())) return '—';
  const shifted = new Date(base.getTime() + PKT_OFFSET_MS);
  let hours = shifted.getUTCHours();
  const minutes = shifted.getUTCMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const hoursStr = String(hours).padStart(2, '0');
  const minutesStr = String(minutes).padStart(2, '0');
  return `${hoursStr}:${minutesStr} ${ampm}`;
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

/**
 * The [start, end] window a report covers.
 *
 * `month` 0 (or absent) means the whole year — that is how a yearly report asks
 * for its range. Getting this wrong is silent: a yearly request that resolves to
 * a single month still renders under a "Year XXXX" title, which is exactly how
 * the payroll and attendance summaries came to hold January only.
 *
 * `end` is inclusive and carries 23:59:59 so records stamped during the last day
 * are not dropped by a `lte` bound.
 */
export function periodWindow(year: number, month?: number | null): { start: Date; end: Date; isYearly: boolean } {
  const isYearly = !month;
  return isYearly
    ? { start: new Date(Date.UTC(year, 0, 1)), end: new Date(Date.UTC(year, 11, 31, 23, 59, 59)), isYearly: true }
    : {
        start: new Date(Date.UTC(year, (month as number) - 1, 1)),
        // Day 0 of the NEXT month is the last day of this one — handles 28/29/30/31.
        end: new Date(Date.UTC(year, month as number, 0, 23, 59, 59)),
        isYearly: false,
      };
}
