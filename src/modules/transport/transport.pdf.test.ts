/**
 * Transport vouchers print on the fee voucher's layout, so they inherit its
 * paper rules: an unpaid voucher is one of four on an A4 sheet, a paid one is a
 * receipt alone on a B6 sheet. These render real bytes and read the page box
 * back, as the fee voucher tests do.
 *
 * Run with: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderVouchers, B6_WIDTH_PT, B6_HEIGHT_PT } from '../fees/fees.pdf';
import { transportVoucherOf } from './transport.pdf';
import type { TransportChallanDetail } from './transport.billing.service';

const school = { name: 'Test School', address: 'Main Road', phone: '0300', email: null, logoDataUri: null };

function challan(over: Partial<TransportChallanDetail> & { staff?: boolean } = {}): TransportChallanDetail {
  const { staff, ...rest } = over;
  return {
    id: 'c1',
    challanNo: 'TR-2026-000001',
    rider: staff
      ? {
          kind: 'STAFF', id: 't1', name: 'Sapna Chand', code: 'EMP-113', active: true, className: null,
          sectionName: null, isDefaultSection: false, staffRole: 'TEACHER', guardianName: 'Chand', phone: null,
        }
      : {
          kind: 'STUDENT', id: 's1', name: 'Sameer Ali', code: 'STD-805', active: true, className: 'Class 1',
          sectionName: 'A', isDefaultSection: false, staffRole: null, guardianName: 'Ghulam Murtza', phone: null,
        },
    routeId: 'r1',
    routeName: 'Garhi',
    year: 2026,
    month: 9,
    issueDate: '2026-09-01',
    dueDate: '2026-09-10',
    baseAmount: '1500.00',
    discount: '0.00',
    lateFee: '0.00',
    amount: '1500.00',
    paid: '0.00',
    balance: '1500.00',
    status: 'UNPAID',
    isOverdue: false,
    lastPaymentDate: null,
    note: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    payments: [],
    previousDues: [],
    previousBalance: '0.00',
    totalPayable: '1500.00',
    ...rest,
  } as TransportChallanDetail;
}

/** Page boxes read straight out of the PDF bytes. */
function mediaBoxes(pdf: Buffer): number[][] {
  return [...pdf.toString('latin1').matchAll(/\/MediaBox \[([^\]]+)\]/g)].map((m) => m[1].trim().split(/\s+/).map(Number));
}

describe('transport voucher shaping', () => {
  test('a student rider is named by admission number and class, under a TRANSPORT title', () => {
    const v = transportVoucherOf(challan());
    assert.equal(v.student.admissionNo, 'STD-805');
    assert.equal(v.student.className, 'Class 1');
    assert.equal(v.labels?.noun, 'TRANSPORT');
    assert.equal(v.labels?.idLabel, undefined, 'students keep the Student ID label');
    assert.equal(v.items[0].label, 'Transport (Garhi)');
  });

  test('a staff rider is named by employee ID and role, with their own signature line', () => {
    const v = transportVoucherOf(challan({ staff: true }));
    assert.equal(v.student.admissionNo, 'EMP-113');
    assert.equal(v.student.className, 'Teacher');
    assert.equal(v.student.sectionName, '');
    assert.equal(v.labels?.idLabel, 'Employee ID');
    assert.equal(v.labels?.signatureLabel, 'Staff Signature');
  });

  test('an implicit section is not printed as a section', () => {
    const v = transportVoucherOf(
      challan({ rider: { ...challan().rider, sectionName: 'Default', isDefaultSection: true } }),
    );
    assert.equal(v.student.sectionName, '');
  });
});

describe('transport voucher pages', () => {
  test('unpaid vouchers print on A4', async () => {
    const pdf = await renderVouchers([challan(), challan({ staff: true })].map(transportVoucherOf), school);
    const [box] = mediaBoxes(pdf);
    assert.ok(box, 'has a page');
    assert.equal(Math.round(box[2]), 595);
    assert.equal(Math.round(box[3]), 842);
  });

  test('a paid voucher prints as a receipt on B6', async () => {
    const paid = challan({ paid: '1500.00', balance: '0.00', status: 'PAID', totalPayable: '0.00', lastPaymentDate: '2026-09-05' });
    const pdf = await renderVouchers([transportVoucherOf(paid)], school);
    const boxes = mediaBoxes(pdf);
    assert.equal(boxes.length, 1, 'one sheet');
    assert.equal(boxes[0][2].toFixed(2), B6_WIDTH_PT.toFixed(2));
    assert.equal(boxes[0][3].toFixed(2), B6_HEIGHT_PT.toFixed(2));
  });
});
