/**
 * Unit tests for the audit list payload trimming.
 *
 * A challan generation stores every student it billed. That array must reach
 * the detail endpoint intact and must NOT reach the list endpoint, or a single
 * page of history ships megabytes. Both halves of that are easy to break
 * silently — nothing about the UI looks wrong when a list response is fat.
 *
 * Run with: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { trimBulkPayload } from './audit.service';

const student = (n: number) => ({
  admissionNo: `STD-${n}`,
  name: `Student ${n}`,
  className: 'Class 1',
  sectionName: 'A',
  parentName: `Parent ${n}`,
  parentPhone: '03001234567',
  challanNo: `CH-2026-${String(n).padStart(6, '0')}`,
  amount: '1400.00',
  items: ['Monthly Tuition = 1400.00'],
});

describe('trimBulkPayload', () => {
  test('replaces the student array with its count', () => {
    const changes = {
      challansCreated: { before: 0, after: 3 },
      _meta: { scope: 'Class 1', students: [student(1), student(2), student(3)] },
    };
    const out = trimBulkPayload(changes) as any;
    assert.equal(out._meta.students, undefined, 'the array must not survive into a list response');
    assert.equal(out._meta.studentsAvailable, 3);
  });

  test('keeps every other field of _meta', () => {
    const changes = {
      _meta: { scope: 'Class 1 — A', period: 'August 2026', dueDate: '2026-08-22', skipped: 2, students: [student(1)] },
    };
    const out = trimBulkPayload(changes) as any;
    assert.equal(out._meta.scope, 'Class 1 — A');
    assert.equal(out._meta.period, 'August 2026');
    assert.equal(out._meta.dueDate, '2026-08-22');
    assert.equal(out._meta.skipped, 2);
  });

  test('keeps the before/after diff rows untouched', () => {
    const changes = {
      challansCreated: { before: 0, after: 1 },
      totalAmount: { before: '0.00', after: '1400.00' },
      _meta: { students: [student(1)] },
    };
    const out = trimBulkPayload(changes) as any;
    assert.deepEqual(out.challansCreated, { before: 0, after: 1 });
    assert.deepEqual(out.totalAmount, { before: '0.00', after: '1400.00' });
  });

  test('leaves ordinary audit rows completely alone', () => {
    const changes = { discount: { before: '0.00', after: '1200.00' } };
    assert.deepEqual(trimBulkPayload(changes), changes);
  });

  test('tolerates null, absent _meta, and a non-array students value', () => {
    assert.equal(trimBulkPayload(null), null);
    assert.deepEqual(trimBulkPayload({ _meta: { scope: 'x' } }), { _meta: { scope: 'x' } });
    assert.deepEqual(trimBulkPayload({ _meta: { students: 'oops' } }), { _meta: { students: 'oops' } });
  });

  test('actually shrinks the payload — the whole point', () => {
    const big = { _meta: { students: Array.from({ length: 800 }, (_, i) => student(i)) } };
    const before = Buffer.byteLength(JSON.stringify(big));
    const after = Buffer.byteLength(JSON.stringify(trimBulkPayload(big)));
    assert.ok(before > 100_000, `expected a large fixture, got ${before}B`);
    assert.ok(after < 200, `trimmed payload should be tiny, got ${after}B`);
  });
});
