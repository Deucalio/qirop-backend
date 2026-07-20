/**
 * Subject colours.
 *
 * Each subject owns exactly one colour: either an admin-picked hex value or,
 * when unset, a built-in hue chosen by the subject's alphabetical rank — which
 * keeps existing timetables stable and every subject visually distinct.
 *
 * The twelve built-ins below are only quick presets; the admin can pick any hex.
 */
import { prisma } from '../../config/prisma';
import { AppError } from '../../utils/apiResponse';

export const BUILT_IN_COLORS = [
  '#6366f1', // Indigo
  '#f43f5e', // Rose
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#0ea5e9', // Sky
  '#d946ef', // Fuchsia
  '#14b8a6', // Teal
  '#f97316', // Orange
  '#8b5cf6', // Violet
  '#84cc16', // Lime
  '#06b6d4', // Cyan
  '#ec4899', // Pink
] as const;

export const BUILT_IN_COLOR_NAMES = [
  'Indigo', 'Rose', 'Emerald', 'Amber', 'Sky', 'Fuchsia',
  'Teal', 'Orange', 'Violet', 'Lime', 'Cyan', 'Pink',
] as const;

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Normalise "#ABC" / "abcdef" / "#AABBCC" to lowercase "#aabbcc". */
export function normalizeHex(raw: string): string {
  let v = raw.trim().toLowerCase();
  if (!v.startsWith('#')) v = `#${v}`;
  // Expand shorthand #abc → #aabbcc.
  if (/^#[0-9a-f]{3}$/.test(v)) {
    v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  }
  if (!HEX_RE.test(v)) {
    throw new AppError(`"${raw}" is not a valid colour. Use a hex code like #4f46e5.`, 400, 'INVALID_COLOR');
  }
  return v;
}

/**
 * Resolve every subject's colour in one pass: explicit choice when set, else a
 * built-in slot from the alphabetical rank.
 */
export async function subjectColorMap(): Promise<Map<string, string>> {
  const all = await prisma.subject.findMany({ orderBy: { name: 'asc' }, select: { id: true, colorHex: true } });
  return new Map(all.map((s, i) => [s.id, s.colorHex ?? BUILT_IN_COLORS[i % BUILT_IN_COLORS.length]]));
}
