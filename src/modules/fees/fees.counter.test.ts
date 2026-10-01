import assert from 'node:assert/strict';
import test from 'node:test';
import { syncChallanCounter } from './fees.service';

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
