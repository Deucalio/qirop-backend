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
  test('a plain one-line tuition voucher packs eight to a sheet', () => {
    assert.equal(perPageFor(Array.from({ length: 8 }, () => voucher(1))), 8);
  });

  test('the imported arrears vouchers — one line each — pack eight up', () => {
    // What the August import produced: a single "Arrears as at 01-08-2026" line.
    assert.equal(perPageFor(Array.from({ length: 222 }, () => voucher(1))), 8);
  });

  test('steps down to six up past three lines', () => {
    assert.equal(perPageFor([voucher(3)]), 8, 'three lines is the last that fits eight up');
    assert.equal(perPageFor([voucher(4)]), 6, 'four must not be squeezed in');
  });

  test('steps down to four up past eleven lines', () => {
    assert.equal(perPageFor([voucher(1, 10)]), 6, 'eleven lines still fits six up');
    assert.equal(perPageFor([voucher(1, 11)]), 4, 'twelve needs the taller cell');
  });

  test('falls back to a whole sheet past eighteen lines', () => {
    assert.equal(perPageFor([voucher(1, 17)]), 4, 'eighteen still fits four up');
    assert.equal(perPageFor([voucher(1, 18)]), 1, 'beyond that it takes the sheet');
  });

  test('never returns a two-up layout', () => {
    // Two-up has the same row height as four-up, so it would waste half a sheet
    // without buying any of the height that actually runs out.
    for (let n = 0; n <= 40; n++) {
      assert.notEqual(perPageFor([voucher(1, n)]), 2, `${n + 1} lines must not choose two-up`);
    }
  });

  test('the LARGEST voucher decides the layout for the whole batch', () => {
    // Uniformity matters more than density: a sheet of mixed sizes has no
    // straight line to cut along.
    const batch = [voucher(1), voucher(1), voucher(1, 30), voucher(1)];
    assert.equal(perPageFor(batch), 1, 'one oversized voucher sets the sheet layout');
  });

  test('charge lines and brought-forward dues both count toward the height', () => {
    assert.equal(perPageFor([voucher(4, 0)]), 6);
    assert.equal(perPageFor([voucher(0, 4)]), 6);
    assert.equal(perPageFor([voucher(2, 2)]), 6);
  });

  test('an empty batch does not crash the print run', () => {
    assert.equal(perPageFor([]), 8);
  });
});
