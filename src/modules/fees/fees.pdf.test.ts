/**
 * Tests for how many fee vouchers go on an A4 sheet.
 *
 * These are printed in bulk and cut apart by hand, so the packing rule has two
 * jobs that pull against each other: fit four to a sheet (the whole point of
 * the redesign), and never clip a student carrying months of arrears. A clipped
 * voucher understates what a family owes, which is worse than wasting paper.
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
  test('a plain one-line tuition voucher packs four to a sheet', () => {
    assert.equal(perPageFor([voucher(1), voucher(1), voucher(1), voucher(1)]), 4);
  });

  test('the imported arrears vouchers — one line each — pack four up', () => {
    // What the August import produced: a single "Arrears as at 01-08-2026" line.
    assert.equal(perPageFor(Array.from({ length: 222 }, () => voucher(1))), 4);
  });

  test('a voucher with several months of dues still fits a quarter sheet', () => {
    assert.equal(perPageFor([voucher(1, 8)]), 4);
  });

  test('drops to two up once one voucher outgrows a quarter sheet', () => {
    // The boundary counts TOTAL lines: one charge line plus eight dues is nine.
    assert.equal(perPageFor([voucher(1, 8)]), 4, 'nine lines is the last that fits');
    assert.equal(perPageFor([voucher(1, 9)]), 2, 'ten must not be squeezed in');
  });

  test('drops to one per sheet for a very long dues list', () => {
    assert.equal(perPageFor([voucher(2, 21)]), 1);
  });

  test('the LARGEST voucher decides the layout for the whole batch', () => {
    // Uniformity matters more than density: a sheet of mixed sizes has no
    // straight line to cut along.
    const batch = [voucher(1), voucher(1), voucher(1, 30), voucher(1)];
    assert.equal(perPageFor(batch), 1, 'one oversized voucher sets the sheet layout');
  });

  test('charge lines and brought-forward dues both count toward the height', () => {
    assert.equal(perPageFor([voucher(10, 0)]), 2);
    assert.equal(perPageFor([voucher(0, 10)]), 2);
    assert.equal(perPageFor([voucher(5, 5)]), 2);
  });

  test('an empty batch does not crash the print run', () => {
    assert.equal(perPageFor([]), 4);
  });
});
