/**
 * Tests for how many fee vouchers go on an A4 sheet.
 *
 * These are printed in bulk and cut apart by hand, so the packing rule has two
 * jobs that pull against each other: fit as many to a sheet as possible (the
 * point of the redesign — a challan used to take a whole page), and never clip
 * a student carrying months of arrears. A clipped voucher understates what a
 * family owes, which is worse than wasting paper.
 *
 * Every bound below is measured, and measured in the WORST case: every voucher
 * in the batch grown to the same height, then rendered and the page count read
 * back. That distinction matters — grid rows size to their own tallest cell, so
 * growing a single challan only stretches its own row. Measured that way,
 * eight-up looked good for eleven lines; grown uniformly it breaks at four.
 *
 *   8 up (4 rows) -> up to 3 lines
 *   6 up (3 rows) -> up to 11 lines
 *   4 up (2 rows) -> up to 18 lines
 *
 * There is no two-up step: two-up is one column of two rows, the same row
 * height as four-up, so it buys width rather than the height that is scarce.
 *
 * Run with: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { perPageFor } from './fees.pdf';

/** A voucher carrying `items` charge lines and `dues` brought-forward months. */
const voucher = (items: number, dues = 0) => ({
  items: Array.from({ length: items }, () => ({})) as any,
  previousDues: Array.from({ length: dues }, () => ({})) as any,
});

describe('perPageFor', () => {
  test('always returns 4 vouchers per A4 page (2x2 grid)', () => {
    assert.equal(perPageFor(Array.from({ length: 4 }, () => voucher(1))), 4);
    assert.equal(perPageFor(Array.from({ length: 20 }, () => voucher(1))), 4);
    assert.equal(perPageFor([voucher(1, 10)]), 4);
  });

  test('empty batch returns 4-up default', () => {
    assert.equal(perPageFor([]), 4);
  });
});
