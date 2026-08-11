/**
 * Tests for how many fee vouchers go on an A4 sheet.
 *
 * These are printed in bulk and cut apart by hand, so the packing rule has two
 * jobs that pull against each other: fit as many to a sheet as possible (the
 * point of the redesign — a challan used to take a whole page), and never clip
 * a student carrying months of arrears. A clipped voucher understates what a
 * family owes, which is worse than wasting paper.
 *
 * The step-downs are calibrated against real rendering, not guessed. Growing a
 * challan one line at a time and re-rendering showed four lines is the last
 * that fits six-up, eleven the last that fits four-up, and twenty-four the last
 * that fits two-up; every boundary below matches a measured page count.
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
  test('a plain one-line tuition voucher packs six to a sheet', () => {
    assert.equal(perPageFor([voucher(1), voucher(1), voucher(1), voucher(1), voucher(1), voucher(1)]), 6);
  });

  test('the imported arrears vouchers — one line each — pack six up', () => {
    // What the August import produced: a single "Arrears as at 01-08-2026" line.
    assert.equal(perPageFor(Array.from({ length: 222 }, () => voucher(1))), 6);
  });

  test('steps down to four up once a voucher passes four lines', () => {
    assert.equal(perPageFor([voucher(1, 3)]), 6, 'four lines is the last that fits six up');
    assert.equal(perPageFor([voucher(1, 4)]), 4, 'five lines needs the taller cell');
  });

  test('steps down to two up once a voucher passes eleven lines', () => {
    assert.equal(perPageFor([voucher(1, 10)]), 4, 'eleven lines still fits four up');
    assert.equal(perPageFor([voucher(1, 11)]), 2, 'twelve needs half a sheet');
  });

  test('falls back to one per sheet for a very long dues list', () => {
    assert.equal(perPageFor([voucher(1, 23)]), 2, 'twenty-four still fits half a sheet');
    assert.equal(perPageFor([voucher(1, 24)]), 1, 'beyond that it takes the whole sheet');
  });

  test('the LARGEST voucher decides the layout for the whole batch', () => {
    // Uniformity matters more than density: a sheet of mixed sizes has no
    // straight line to cut along.
    const batch = [voucher(1), voucher(1), voucher(1, 30), voucher(1)];
    assert.equal(perPageFor(batch), 1, 'one oversized voucher sets the sheet layout');
  });

  test('charge lines and brought-forward dues both count toward the height', () => {
    assert.equal(perPageFor([voucher(5, 0)]), 4);
    assert.equal(perPageFor([voucher(0, 5)]), 4);
    assert.equal(perPageFor([voucher(3, 2)]), 4);
  });

  test('an empty batch does not crash the print run', () => {
    assert.equal(perPageFor([]), 6);
  });
});
