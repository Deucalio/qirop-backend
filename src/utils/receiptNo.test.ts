import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { receiptSuffixFromQuery } from './receiptNo';

describe('receiptSuffixFromQuery', () => {
  test('a printed receipt number becomes the id suffix to match', () => {
    assert.equal(receiptSuffixFromQuery('2QT8X9'), '2qt8x9');
  });

  test('the leading # from the receipt is accepted', () => {
    assert.equal(receiptSuffixFromQuery('  #2QT8X9 '), '2qt8x9');
  });

  test('anything not shaped like a receipt number is left to the normal search', () => {
    assert.equal(receiptSuffixFromQuery('Ali Khan'), null);
    assert.equal(receiptSuffixFromQuery('2QT8X'), null);
    assert.equal(receiptSuffixFromQuery('CH-2026-000123'), null);
    assert.equal(receiptSuffixFromQuery(''), null);
  });
});
