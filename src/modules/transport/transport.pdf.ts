/**
 * Transport challan and receipt PDFs.
 *
 * Printed on the fee voucher's own layout (see `voucherBlock`) rather than a
 * second design: the office hands out one kind of bill, the parent reads one
 * kind of bill, and a change to how vouchers look lands on both at once. Only
 * the wording differs — the title says TRANSPORT, and a staff rider is named
 * by employee ID and role instead of a class.
 */
import { FeeItemType } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError, NotFound } from '../../utils/apiResponse';
import { money, round2, sum, toMoneyString, ZERO } from '../../utils/money';
import { pktDayString } from '../../utils/pktDate';
import { STAFF_ROLE_LABELS } from '../../utils/staffRoles';
import {
  B6_HEIGHT_PT,
  B6_WIDTH_PT,
  RECEIPT_MARGIN,
  loadSchool,
  render,
  renderVouchers,
  voucherBlock,
  type VoucherData,
  type VoucherLabels,
} from '../fees/fees.pdf';
import { getTransportChallan, receiptNoOf, type TransportChallanDetail } from './transport.billing.service';

const STUDENT_LABELS: Partial<VoucherLabels> = {
  noun: 'TRANSPORT',
  totalLabel: 'TOTAL PAYABLE',
};

const STAFF_LABELS: Partial<VoucherLabels> = {
  noun: 'TRANSPORT',
  idLabel: 'Employee ID',
  personLabel: 'Staff',
  placementLabel: 'Role',
  totalLabel: 'TOTAL PAYABLE',
  signatureLabel: 'Staff Signature',
};

function toVoucher(c: TransportChallanDetail): VoucherData {
  const r = c.rider;
  const isStaff = r.kind === 'STAFF';
  return {
    challanNo: c.challanNo,
    year: c.year,
    month: c.month,
    issueDate: c.issueDate,
    dueDate: c.dueDate,
    baseAmount: c.baseAmount,
    discount: c.discount,
    lateFee: c.lateFee,
    amount: c.amount,
    paidAmount: c.paid,
    cashPaid: c.paid,
    staffCovered: '0.00',
    lastPaymentDate: c.lastPaymentDate,
    // The voucher prefixes each line with its month: "September 2026 — Transport (Garhi)".
    items: [{ id: c.id, type: FeeItemType.TRANSPORT, label: `Transport (${c.routeName})`, amount: c.baseAmount }],
    previousDues: c.previousDues,
    previousBalance: c.previousBalance,
    advanceCredit: '0.00',
    totalPayable: c.totalPayable,
    student: {
      name: r.name,
      admissionNo: r.code,
      className: isStaff ? (r.staffRole ? STAFF_ROLE_LABELS[r.staffRole] : 'Staff') : (r.className ?? ''),
      // An implicit section is not a real section and is not printed.
      sectionName: isStaff || r.isDefaultSection ? '' : (r.sectionName ?? ''),
      parentName: r.guardianName,
    },
    labels: isStaff ? STAFF_LABELS : STUDENT_LABELS,
  };
}

/** One transport challan: an unpaid voucher, or a receipt once money has landed. */
export async function renderTransportChallanPdf(id: string): Promise<{ buffer: Buffer; challanNo: string }> {
  const [c, school] = await Promise.all([getTransportChallan(id), loadSchool()]);
  return { buffer: await renderVouchers([toVoucher(c)], school), challanNo: c.challanNo };
}

/** Many transport challans in one document, four unpaid vouchers to an A4 sheet. */
export async function renderTransportChallansBatchPdf(ids: string[]): Promise<Buffer> {
  const school = await loadSchool();
  const challans = await Promise.all(ids.map((id) => getTransportChallan(id)));
  return renderVouchers(challans.map(toVoucher), school);
}

/**
 * The receipt for ONE transport payment, on a B6 sheet like a fee receipt.
 *
 * Figures are as they stood when this money was handed over — what was paid
 * before it, this receipt, and the balance it left — so reprinting an old
 * receipt after later instalments still shows what that receipt proved.
 */
export async function renderTransportReceiptPdf(paymentId: string): Promise<{ buffer: Buffer; receiptNo: string }> {
  const payment = await prisma.transportPayment.findUnique({ where: { id: paymentId } });
  if (!payment) throw NotFound('Payment not found');
  if (payment.isReversed) {
    throw new AppError('This payment was reversed, so there is no receipt to print for it.', 409, 'PAYMENT_REVERSED');
  }

  const [c, school] = await Promise.all([getTransportChallan(payment.challanId), loadSchool()]);
  const earlier = c.payments.filter(
    (p) => !p.isReversed && p.id !== payment.id && p.createdAt < payment.createdAt.toISOString(),
  );
  const paidEarlier = sum(earlier.map((p) => p.amount));
  const paidToDate = round2(paidEarlier.plus(money(payment.amount)));
  const balanceAfter = round2(money(c.amount).minus(paidToDate));

  const voucher: VoucherData = {
    ...toVoucher(c),
    // This receipt settles this month only; other months' arrears are not part of it.
    previousDues: [],
    previousBalance: '0.00',
    paidAmount: toMoneyString(paidToDate),
    cashPaid: toMoneyString(paidToDate),
    totalPayable: toMoneyString(balanceAfter.lessThan(0) ? ZERO : balanceAfter),
    lastPaymentDate: pktDayString(payment.paymentDate),
  };

  const block = voucherBlock(voucher, school, Boolean(school.logoDataUri), 1, {
    receiptNo: receiptNoOf(payment.id),
    date: pktDayString(payment.paymentDate),
    amountApplied: toMoneyString(payment.amount),
    paidEarlier: toMoneyString(paidEarlier),
  });

  const buffer = await render({
    pageSize: { width: B6_WIDTH_PT, height: B6_HEIGHT_PT },
    pageOrientation: 'portrait',
    pageMargins: [RECEIPT_MARGIN, RECEIPT_MARGIN, RECEIPT_MARGIN, RECEIPT_MARGIN],
    content: [block],
    ...(school.logoDataUri ? { images: { logo: school.logoDataUri } } : {}),
    defaultStyle: { font: 'Roboto', fontSize: 6 },
  });
  return { buffer, receiptNo: receiptNoOf(payment.id) };
}

// Exposed for the PDF preview test, which renders without a database.
export { toVoucher as transportVoucherOf };
