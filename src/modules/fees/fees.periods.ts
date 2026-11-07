/**
 * The billing months a dashboard period covers.
 *
 * A challan belongs to the month it is billed for (its `year`/`month`), not
 * the day it happened to be generated. Selecting challans by `createdAt` put a
 * month's challans generated early (say on 28 Oct for November) into the wrong
 * month, so a dashboard could disagree with the Challans page for the same
 * month. Both the summary cards and the trend chart take their months from
 * here, so they always cover the same challans.
 *
 * Pure: `today` is passed in, so this is testable without a clock.
 */
export interface BillingMonth {
  year: number;
  month: number; // 1..12
}

/** 'YYYY-MM-DD' → the first of that month, in UTC. */
function monthOf(day: string): Date {
  const [y, m] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1));
}

/**
 * `startDate`/`endDate` ('YYYY-MM-DD') select every month the range touches,
 * inclusive. Otherwise `months` selects that many months ending with the month
 * of `today`. At most `limit` months are returned.
 */
export function billingMonths(
  opts: { months?: number; startDate?: string; endDate?: string },
  today: Date,
  limit = Number.POSITIVE_INFINITY,
): BillingMonth[] {
  const out: BillingMonth[] = [];

  if (opts.startDate && opts.endDate) {
    const cur = monthOf(opts.startDate);
    const last = monthOf(opts.endDate);
    while (cur <= last && out.length < limit) {
      out.push({ year: cur.getUTCFullYear(), month: cur.getUTCMonth() + 1 });
      cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
    return out;
  }

  const n = Math.min(limit, Math.max(1, opts.months ?? 1));
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    out.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  }
  return out;
}
