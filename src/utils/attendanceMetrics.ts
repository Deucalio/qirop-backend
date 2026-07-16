import type { AttendanceStatus } from '@prisma/client';

export interface AttendanceSummary {
  present: number;
  absent: number;
  late: number;
  leave: number;
  marked: number;
  /** (PRESENT + LATE) / markedDays, as an integer percentage. Single source of truth. */
  rate: number;
}

/** Aggregate a set of attendance statuses into counts + the headline rate. */
export function summarize(statuses: AttendanceStatus[]): AttendanceSummary {
  const counts = { present: 0, absent: 0, late: 0, leave: 0 };
  for (const s of statuses) {
    if (s === 'PRESENT') counts.present++;
    else if (s === 'ABSENT') counts.absent++;
    else if (s === 'LATE') counts.late++;
    else if (s === 'LEAVE') counts.leave++;
  }
  const marked = statuses.length;
  const rate = marked === 0 ? 0 : Math.round(((counts.present + counts.late) / marked) * 100);
  return { ...counts, marked, rate };
}
