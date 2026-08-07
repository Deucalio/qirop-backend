import { StaffRole } from '@prisma/client';

/**
 * The roles that may be put in front of a class.
 *
 * A driver, gardener or peon is real staff — salary, attendance, and a
 * staff-child fee concession all apply — but must never be assignable as a
 * class teacher, subject teacher, or homework author. Keeping the rule in one
 * place means every academic surface agrees on what "teaching staff" means.
 */
export const TEACHING_STAFF_ROLES: StaffRole[] = [StaffRole.TEACHER, StaffRole.QARI];

export function isTeachingRole(role: StaffRole | null | undefined): boolean {
  return !!role && TEACHING_STAFF_ROLES.includes(role);
}

/** Human label for a role, for messages and dropdowns. */
export const STAFF_ROLE_LABELS: Record<StaffRole, string> = {
  TEACHER: 'Teacher',
  QARI: 'Qari',
  PRINCIPAL: 'Principal',
  CLERK: 'Clerk',
  ACCOUNTANT: 'Accountant',
  LIBRARIAN: 'Librarian',
  PEON: 'Peon',
  GUARD: 'Guard',
  DRIVER: 'Driver',
  GARDENER: 'Gardener',
  COOK: 'Cook',
  CLEANER: 'Cleaner',
  OTHER: 'Other',
};
