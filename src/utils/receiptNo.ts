/**
 * Receipt numbers are not stored. A receipt's number is the last six
 * characters of its payment id, uppercased (`receiptNoOf` in the fees and
 * transport modules), so looking one up means matching the id's suffix.
 *
 * Returns the lowercase suffix to match when the query is shaped like a
 * receipt number — six letters/digits, an optional leading `#` — else null.
 * Ids are cuids, which are lowercase, hence the case fold.
 */
/**
 * An expense's voucher number, made the same way as a receipt number: the
 * last six characters of its id, uppercased. Expenses have no stored number,
 * and this gives the printed ledger something to reference.
 */
export const voucherNoOf = (expenseId: string) => expenseId.slice(-6).toUpperCase();

export function receiptSuffixFromQuery(q: string | null | undefined): string | null {
  const s = (q ?? '').trim().replace(/^#/, '');
  return /^[a-z0-9]{6}$/i.test(s) ? s.toLowerCase() : null;
}
