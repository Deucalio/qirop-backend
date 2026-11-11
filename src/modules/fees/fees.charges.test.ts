/**
 * Which typed charges count as transport, and so are refused on fee challans.
 * The cases are the real labels the office typed before the rule existed.
 *
 * Run with: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeTransport } from './fees.charges';

describe('looksLikeTransport', () => {
  test('catches transport however it was spelt', () => {
    for (const l of ['transport', 'Transport', 'transpot', 'Transpot', 'tranpot', 'Tranpot', 'Monthlay and transpout', 'Van fare', 'Bus']) {
      assert.equal(looksLikeTransport(l), true, l);
    }
  });

  test('leaves ordinary charges alone', () => {
    for (const l of ['Admetion', 'June', 'Month fess difference', 'Old', 'Sports kit', 'Exam fee', 'Annual charges', 'Report card', 'Trip', 'Sports week', 'Stationery', 'Uniform']) {
      assert.equal(looksLikeTransport(l), false, l);
    }
  });
});
