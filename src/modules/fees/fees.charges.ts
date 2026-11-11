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
