/**
 * How the History page groups audit rows for filtering.
 *
 * Rows were written over months by different modules, and their `action` and
 * `module` values are not uniform: an edit is UPDATE, UPDATED or
 * CHALLAN_EDITED; transport was logged under FEES; homework under TIMETABLE.
 * Filtering on the raw strings meant "Updated" missed most edits and there was
 * no way to see transport on its own. These groupings are applied at query
 * time, so every existing row lands in the right place without rewriting it.
 *
 * The frontend badge uses the same rules (src/lib/auditCategories.ts) — keep
 * the two in step, or a row's badge and the filter that finds it will disagree.
 */
import type { Prisma } from '@prisma/client';

/**
 * Action categories, checked IN ORDER: the first whose pattern appears in the
 * action wins. Order matters — UNASSIGN must be tested before ASSIGN, RESET
 * before the SET of "updated", STATUS_CHANGE before CHANGE.
 */
export const ACTION_CATEGORIES: { key: string; patterns: string[] }[] = [
  { key: 'LOGIN', patterns: ['LOGIN'] },
  { key: 'CHECKIN', patterns: ['CHECKIN'] },
  { key: 'REVERSE', patterns: ['REVERS'] },
  { key: 'DELETE', patterns: ['DELETE', 'REMOVE', 'PURGE', 'CANCEL', 'UNASSIGN'] },
  { key: 'PAYMENT', patterns: ['PAYMENT', 'PAID'] },
  { key: 'DISCOUNT', patterns: ['DISCOUNT'] },
  { key: 'RESET', patterns: ['RESET'] },
  { key: 'STATUS', patterns: ['STATUS', 'ACTIVATE'] },
  { key: 'MOVE', patterns: ['PROMOT', 'TRANSFER'] },
  { key: 'CREATE', patterns: ['CREATE', 'ENROLL', '_ADD', 'ADDED', 'GENERATE', 'ASSIGN'] },
  { key: 'UPDATE', patterns: ['UPDATE', 'EDIT', 'SET', 'CHANGE', 'STRUCTURE'] },
];

/** The category an action falls into, or null for one no rule covers. */
export function actionCategory(action: string): string | null {
  const a = (action || '').toUpperCase();
  for (const c of ACTION_CATEGORIES) {
    if (c.patterns.some((p) => a.includes(p))) return c.key;
  }
  return null;
}

const containsAny = (patterns: string[]): Prisma.AuditLogWhereInput => ({
  OR: patterns.map((p) => ({ action: { contains: p, mode: 'insensitive' as const } })),
});

/**
 * The WHERE clause for an action filter value. A category key matches what
 * `actionCategory` would assign; anything else is matched exactly, so an old
 * link carrying a raw action name still works.
 */
export function actionWhere(value: string): Prisma.AuditLogWhereInput {
  const index = ACTION_CATEGORIES.findIndex((c) => c.key === value);
  if (index === -1) return { action: value };
  const earlier = ACTION_CATEGORIES.slice(0, index).flatMap((c) => c.patterns);
  return {
    AND: [
      containsAny(ACTION_CATEGORIES[index].patterns),
      // Not claimed by a category checked before this one.
      ...(earlier.length ? [{ NOT: containsAny(earlier) }] : []),
    ],
  };
}

/**
 * The WHERE clause for a module filter value.
 *
 * TRANSPORT and HOMEWORK are recognised by what the row is about, because
 * their older rows were filed under FEES and TIMETABLE. FEES and CLASSES in
 * turn leave those rows out, so each row appears under exactly one module.
 */
export function moduleWhere(value: string): Prisma.AuditLogWhereInput {
  // Checked in this order, like `displayModule` on the frontend: a transport
  // row is transport wherever it was filed, then homework, then the rest.
  const isTransport: Prisma.AuditLogWhereInput = {
    OR: [{ module: 'TRANSPORT' }, { targetType: { startsWith: 'Transport' } }],
  };
  const isHomework: Prisma.AuditLogWhereInput = { OR: [{ module: 'HOMEWORK' }, { targetType: 'Homework' }] };

  switch (value) {
    case 'TRANSPORT':
      return isTransport;
    case 'HOMEWORK':
      return { AND: [isHomework, { NOT: isTransport }] };
    case 'CLASSES':
      return { AND: [{ module: { in: ['CLASSES', 'TIMETABLE'] } }, { NOT: isTransport }, { NOT: isHomework }] };
    default:
      return { AND: [{ module: value }, { NOT: isTransport }, { NOT: isHomework }] };
  }
}
