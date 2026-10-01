import assert from 'node:assert/strict';
import test from 'node:test';
import { renderSalarySlipDocument, B6_WIDTH_PT, B6_HEIGHT_PT } from './salaries.pdf';

const school = {
  name: 'Test Model School',
  address: 'Main Bypass Road',
  phone: '0300-1234567',
  email: null,
  logoDataUri: null,
};

const slip = {
  teacherName: 'Ayesha Khan',
  employeeId: 'EMP-011',
  year: 2026,
  month: 10,
  basicSalary: '45000.00',
  allowances: '2500.00',
  deductions: '500.00',
  staffFeeDeduction: '3000.00',
  netSalary: '44000.00',
  status: 'PAID',
  paidDate: '2026-10-31',
  notes: null,
  breakdown: {
    transportRoute: null,
    transportFee: '0.00',
    transportCovered: '0.00',
    childrenCovered: '3000.00',
    uncoveredPayable: '0.00',
    children: [
      {
        studentName: 'Hassan Khan',
        challanNo: 'CH-2026-001701',
        period: { year: 2026, month: 10 },
        billable: '3000.00',
        covered: '3000.00',
        payable: '0.00',
      },
    ],
  },
};

function mediaBoxes(pdf: Buffer): number[][] {
  return [...pdf.toString('latin1').matchAll(/\/MediaBox \[([^\]]+)\]/g)].map((match) => match[1].trim().split(/\s+/).map(Number));
}

test('salary slips use the compact B6 receipt page geometry matching challans', async () => {
  const pdf = await renderSalarySlipDocument(slip as never, school as never);
  const [box] = mediaBoxes(pdf);

  assert.ok(box, 'has a page');
  assert.ok(Math.abs(box[2] - B6_WIDTH_PT) < 0.001, `width ${box[2]} expected ${B6_WIDTH_PT}`);
  assert.ok(Math.abs(box[3] - B6_HEIGHT_PT) < 0.001, `height ${box[3]} expected ${B6_HEIGHT_PT}`);
  assert.match(pdf.toString('latin1'), /\/PrintScaling\s*\/None/);
});
