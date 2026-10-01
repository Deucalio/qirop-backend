import assert from 'node:assert/strict';
import test from 'node:test';
import { FeeItemType } from '@prisma/client';
import {
  appendMonthlyBilling,
  hasChallanSettlement,
  isCertificateOnlyChallan,
  syncChallanCounter,
  unbilledExtraItems,
} from './fees.service';

function counterTransaction(
  lastNumber: number,
  highestNo: string,
  afterUpsert?: (setLastNumber: (next: number) => void) => void,
) {
  const tx = {
    feeChallan: {
      findFirst: async () => ({ challanNo: highestNo }),
    },
    challanCounter: {
      upsert: async ({ create }: { create: { lastNumber: number } }) => {
        if (lastNumber < 0) lastNumber = create.lastNumber;
        afterUpsert?.((next) => { lastNumber = next; });
        return { lastNumber };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { lastNumber: { lt: number } };
        data: { lastNumber: number };
      }) => {
        if (lastNumber < where.lastNumber.lt) lastNumber = data.lastNumber;
        return { count: lastNumber === data.lastNumber ? 1 : 0 };
      },
    },
  };

  return {
    tx,
    getLastNumber: () => lastNumber,
  };
}

test('syncChallanCounter advances a stale counter to the highest existing challan', async () => {
  const state = counterTransaction(1598, 'CH-2026-001600');

  await syncChallanCounter(state.tx as never, 2026);

  assert.equal(state.getLastNumber(), 1600);
});

test('syncChallanCounter never overwrites a newer concurrent allocation', async () => {
  const state = counterTransaction(1600, 'CH-2026-001600', (setLastNumber) => {
    // Simulate another allocator issuing CH-2026-001601 after the upsert.
    setLastNumber(1601);
  });

  await syncChallanCounter(state.tx as never, 2026);

  assert.equal(state.getLastNumber(), 1601);
});

test('certificate-only challans are eligible for monthly tuition, unlike normal challans', () => {
  assert.equal(isCertificateOnlyChallan([{ type: FeeItemType.CERTIFICATE }]), true);
  assert.equal(isCertificateOnlyChallan([{ type: FeeItemType.CERTIFICATE }, { type: FeeItemType.TUITION }]), false);
  assert.equal(isCertificateOnlyChallan([]), false);
});

test('adding monthly billing preserves certificate charges, discounts, and late fees', () => {
  const totals = appendMonthlyBilling(
    { baseAmount: '2000.00' as never, discount: '0.00' as never, lateFee: '50.00' as never },
    '2000.00' as never,
    '500.00' as never,
  );

  assert.equal(totals.base.toFixed(2), '4000.00');
  assert.equal(totals.discount.toFixed(2), '500.00');
  assert.equal(totals.amount.toFixed(2), '3550.00');
});

test('salary-covered challans are treated as settled and cannot be deleted', () => {
  assert.equal(hasChallanSettlement({ staffCovered: '0.00' as never, allocations: [] }), false);
  assert.equal(hasChallanSettlement({ staffCovered: '1.00' as never, allocations: [] }), true);
  assert.equal(hasChallanSettlement({ staffCovered: '0.00' as never, allocations: [{}] }), true);
});

test('later extra-charge runs add only new lines and deduplicate the request', () => {
  const extras = unbilledExtraItems(
    [{ type: FeeItemType.EXAM, label: 'Term Exam', amount: '500.00' as never }],
    [
      { type: FeeItemType.EXAM, label: 'Term Exam', amount: '500.00' },
      { type: FeeItemType.OTHER, label: 'Stationery', amount: '250.00' },
      { type: FeeItemType.OTHER, label: 'Stationery', amount: '250.0' },
    ],
  );

  assert.deepEqual(extras, [{ type: FeeItemType.OTHER, label: 'Stationery', amount: '250.00' }]);
});
