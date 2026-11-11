/**
 * Rules for charges typed onto a fee challan by hand.
 *
 * Transport has been billed on transport challans since August 2026 (staff)
 * and September 2026 (students). The office kept adding it to fee challans as
 * free text ("transport", "transpot", "tranpot"), filed as Other, where it
 * slipped past the guard that stops a rider being billed twice. So a typed
 * charge that reads like transport is refused unless the person confirms it
 * is something else. Kept in step with suggestChargeType in src/lib/fees.ts.
 */
const TRANSPORT_TEXT = /tr?a?n?s?p(o|ou)?r?t|tranpot|transpot|transpout|\bvan\b|\bbus\b|\bfare\b/;

export const looksLikeTransport = (label: string): boolean => TRANSPORT_TEXT.test(label.toLowerCase());

export const TRANSPORT_ON_FEE_CHALLAN_MESSAGE =
  'This looks like transport. Transport is billed on transport challans (Transport page), not on fee challans. ' +
  'If it is something else, confirm that and add it again.';

/**
 * The opening balances imported from the 01-08-2026 "List of Overall Balances"
 * sheet were stored as OTHER lines with this label (see
 * scripts/import-opening-balances.ts). They are old dues, mostly tuition from
 * before the system, not exam fees or ad-hoc charges, so the report names them
 * separately. Matched by prefix so a later sheet with another date also counts.
 */
export const OPENING_ARREARS_PREFIX = 'Arrears as at ';

/**
 * An item's head for the collections split. OTHER is a catch-all type, so it is
 * divided further: opening arrears by their exact label, and every other OTHER
 * line keyed by its own text ("OTHER|transpot") so the report can list what the
 * office actually typed. EXAM stays EXAM.
 */
export function collectionHeadOf(item: { type: string; label: string | null }): string {
  if (item.type !== 'OTHER') return item.type;
  const label = (item.label ?? '').trim();
  if (label.startsWith(OPENING_ARREARS_PREFIX)) return 'ARREARS';
  return `OTHER|${label || 'No label'}`;
}
