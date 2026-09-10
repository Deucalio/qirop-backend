/**
 * The receipt for ONE payment.
 *
 * Distinct from the challan PDF, which is the bill. Printing a receipt used to
 * open the challan it settled, so two payments against the same challan printed
 * the same sheet — a family handing over Rs 1,500 got a document headed
 * "Total fees payable 4,600, fee paid 4,500", which is the account's position
 * rather than proof of what they just paid.
 *
 * This prints what was actually received: this receipt's amount, the date, the
 * method, who took it, and exactly which bills it was applied to.
 */
import PdfPrinterModule from 'pdfmake';
import type { TDocumentDefinitions, Content, TFontDictionary } from 'pdfmake/interfaces';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { fetchFileBuffer } from '../../services/storage';
import { NotFound } from '../../utils/apiResponse';
import { money, toMoneyString, round2, ZERO } from '../../utils/money';
import { pktDayString } from '../../utils/pktDate';

type PdfKitDoc = NodeJS.ReadableStream & { end(): void };
const PdfPrinter = PdfPrinterModule as unknown as {
  new (fonts: TFontDictionary): { createPdfKitDocument(doc: TDocumentDefinitions): PdfKitDoc };
};
const printer = new PdfPrinter({
  Roboto: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
});

const MONTHS = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const METHOD_LABEL: Record<string, string> = {
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank Transfer',
  CHEQUE: 'Cheque',
  OTHER: 'Other',
};

/** The same B6 sheet the paid challan prints on, so one paper stock serves both. */
const MM = 72 / 25.4;
const B6_WIDTH_PT = 125 * MM;
const B6_HEIGHT_PT = 176 * MM;
const MARGIN = 10;

/** Matches the receipt number the payments screen shows, so they can be matched up. */
export function receiptNoOf(paymentId: string): string {
  return paymentId.slice(-6).toUpperCase();
}

function render(doc: TDocumentDefinitions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = printer.createPdfKitDocument(doc);
    // Tell a reader not to rescale a deliberately-sized page, as the challan does.
    try {
      const d = pdf as unknown as {
        _root?: { data: Record<string, unknown> };
        _pageBuffer?: Array<{ dictionary: { data: Record<string, unknown> } }>;
        ref?: (data: Record<string, unknown>) => unknown;
      };
      if (d._root && typeof d.ref === 'function') {
        d._root.data.ViewerPreferences = d.ref({ PrintScaling: 'None' });
      }
      for (const page of d._pageBuffer ?? []) {
        if (page.dictionary.data.MediaBox) page.dictionary.data.CropBox = page.dictionary.data.MediaBox;
      }
    } catch {
      // Reaching into pdfkit's internals is a convenience, not a requirement.
    }
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    pdf.end();
  });
}

/** What a receipt needs off a payment. Shared by the single and batch renders. */
const RECEIPT_INCLUDE = {
  receivedBy: { select: { fullName: true } },
  reversedBy: { select: { fullName: true } },
  student: {
    include: {
      section: { include: { class: true } },
      parent: { include: { user: { select: { fullName: true } } } },
    },
  },
  allocations: {
    include: {
      challan: {
        select: {
          challanNo: true,
          year: true,
          month: true,
          amount: true,
          staffCovered: true,
          allocations: { select: { amountApplied: true, payment: { select: { isReversed: true } } } },
        },
      },
    },
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.FeePaymentInclude;

type ReceiptPayment = Prisma.FeePaymentGetPayload<{ include: typeof RECEIPT_INCLUDE }>;
type SchoolRow = { name: string; address: string | null; phone: string | null } | null;

async function loadSchool() {
  const school = await prisma.school.findFirst();
  const logo = await fetchFileBuffer(school?.logoUrl);
  return {
    school: school as SchoolRow,
    logoDataUri: logo ? `data:${logo.contentType};base64,${logo.buffer.toString('base64')}` : null,
  };
}

/** One receipt's printable block. `pageBreak` starts it on a fresh sheet. */
function receiptContent(
  payment: ReceiptPayment,
  school: SchoolRow,
  logoDataUri: string | null,
  pageBreak: boolean,
): Content {
  const receiptNo = receiptNoOf(payment.id);
  const money2 = (v: unknown) => Number(v as string).toLocaleString('en-PK');
  const dmy = (iso: string) => {
    const [y, m, d] = iso.split('-');
    return d && m && y ? `${d}-${m}-${y}` : iso;
  };

  const received = money(payment.amount);
  const applied = payment.allocations.reduce((acc, a) => acc.plus(money(a.amountApplied)), ZERO);
  // Anything not matched to a bill is sitting on the student's account.
  const heldAsCredit = round2(received.minus(applied));

  const studentName = `${payment.student.firstName}${payment.student.lastName ? ` ${payment.student.lastName}` : ''}`;
  /*
   * B6 is fixed paper and this receipt's content is short, so it is set larger
   * rather than left floating in the top half of the sheet. Chosen by measuring
   * the rendered page, not guessed.
   */
  const K = 1.42;
  const s = (n: number) => Math.round(n * K * 100) / 100;

  const kv = (label: string, value: string, opts: { bold?: boolean } = {}) => ({
    text: [{ text: `${label}: `, bold: true }, { text: value || '-', bold: opts.bold }],
    fontSize: s(8.5),
    margin: [0, s(1.4), 0, s(1.4)] as [number, number, number, number],
  });

  const cell = (text: string, opts: { bold?: boolean; right?: boolean; size?: number } = {}) => ({
    text,
    fontSize: opts.size ?? 8.5,
    bold: opts.bold ?? false,
    ...(opts.right ? { alignment: 'right' as const } : {}),
    margin: [0, s(3), 0, s(3)] as [number, number, number, number],
  });

  const allocationRows = payment.allocations.map((a) => {
    const c = a.challan;
    const settled = c.allocations
      .filter((x) => !x.payment.isReversed)
      .reduce((acc, x) => acc.plus(money(x.amountApplied)), ZERO)
      .plus(money(c.staffCovered));
    const balance = round2(money(c.amount).minus(settled));
    return [
      cell(`${MONTHS[c.month] ?? ''} ${c.year}`),
      cell(c.challanNo.replace(/^CH-/, ''), { size: 8 }),
      cell(money2(a.amountApplied), { right: true, bold: true }),
      cell(balance.greaterThan(0) ? money2(toMoneyString(balance)) : '0', { right: true }),
    ];
  });

  const content: Content[] = [
    {
      table: {
        widths: ['*'],
        body: ([
          [
            {
              text: 'FEE PAYMENT RECEIPT',
              fontSize: s(13),
              bold: true,
              alignment: 'center',
              margin: [0, s(6), 0, s(6)],
            },
          ],
          [
            {
              columns: [
                { text: [{ text: 'Receipt No: ', bold: true }, receiptNo], fontSize: s(9) },
                {
                  text: [{ text: 'Date: ', bold: true }, dmy(pktDayString(payment.paymentDate))],
                  fontSize: s(9),
                  alignment: 'right',
                },
              ],
              margin: [s(8), s(5), s(8), s(5)],
            },
          ],
          [
            logoDataUri
              ? {
                  columns: [
                    { image: 'logo', fit: [s(30), s(30)], width: s(32) },
                    {
                      stack: [
                        { text: (school?.name ?? 'School').toUpperCase(), fontSize: s(10), bold: true, lineHeight: 1.1 },
                        ...(school?.address ? [{ text: school.address, fontSize: s(7.5), lineHeight: 1.1 }] : []),
                        ...(school?.phone ? [{ text: school.phone, fontSize: s(7.5), lineHeight: 1.1 }] : []),
                      ],
                      margin: [0, 1, 0, 0],
                    },
                  ],
                  columnGap: 6,
                  margin: [s(8), s(5), s(8), s(5)],
                }
              : {
                  stack: [
                    { text: (school?.name ?? 'School').toUpperCase(), fontSize: s(10), bold: true },
                    ...(school?.address ? [{ text: school.address, fontSize: s(7.5) }] : []),
                  ],
                  margin: [s(8), s(5), s(8), s(5)],
                },
          ],
          [
            {
              stack: [
                kv('Student', studentName),
                kv('Father', payment.student.parent.user.fullName),
                {
                  columns: [
                    kv('Student ID', payment.student.admissionNo),
                    {
                      // Same form the challan uses, so the two documents for one
                      // family do not disagree about which class they are in.
                      ...kv(
                        'Class',
                        `${payment.student.section.class.name} ${payment.student.section.name}`.trim(),
                      ),
                      alignment: 'right',
                    },
                  ],
                },
              ],
              margin: [s(8), s(5), s(8), s(5)],
            },
          ],
          // The figure this document exists to prove.
          [
            {
              table: {
                widths: ['*', 'auto'],
                body: [
                  [
                    { text: 'AMOUNT RECEIVED', fontSize: s(11), bold: true, margin: [0, s(5), 0, s(5)] },
                    {
                      text: `Rs. ${money2(payment.amount)}`,
                      fontSize: s(13),
                      bold: true,
                      alignment: 'right',
                      margin: [0, s(4), 0, s(4)],
                    },
                  ],
                ],
              },
              layout: 'noBorders',
              margin: [s(8), s(2), s(8), s(2)],
            },
          ],
          [
            {
              columns: [
                kv('Paid by', METHOD_LABEL[payment.method] ?? payment.method),
                { ...kv('Received by', payment.receivedBy.fullName), alignment: 'right' },
              ],
              margin: [s(8), s(4), s(8), s(4)],
            },
          ],
          [
            {
              stack: [
                {
                  text: 'APPLIED TO THESE BILLS',
                  fontSize: s(8),
                  bold: true,
                  margin: [0, 0, 0, 3],
                },
                allocationRows.length > 0
                  ? {
                      table: {
                        headerRows: 1,
                        widths: ['*', 'auto', s(55), s(50)],
                        body: [
                          [
                            cell('Month', { bold: true, size: 8 }),
                            cell('Voucher', { bold: true, size: 8 }),
                            cell('Applied', { bold: true, right: true, size: 8 }),
                            cell('Bill left', { bold: true, right: true, size: 8 }),
                          ],
                          ...allocationRows,
                        ],
                      },
                      layout: {
                        hLineWidth: (i: number) => (i === 1 ? 0.5 : 0.25),
                        vLineWidth: () => 0,
                        hLineColor: () => '#000000',
                        paddingLeft: () => 0,
                        paddingRight: () => 0,
                        paddingTop: () => 0,
                        paddingBottom: () => 0,
                      },
                    }
                  : {
                      text: 'Not applied to any bill — held as advance credit.',
                      fontSize: s(8.5),
                      italics: true,
                    },
                ...(heldAsCredit.greaterThan(0) && allocationRows.length > 0
                  ? [
                      {
                        text: `Rs. ${money2(toMoneyString(heldAsCredit))} of this receipt is held as advance credit.`,
                        fontSize: s(8),
                        italics: true,
                        margin: [0, s(3), 0, 0] as [number, number, number, number],
                      },
                    ]
                  : []),
                // "Bill left" is a live figure, so the sheet has to date itself.
                {
                  text: 'The "Bill left" column shows what those bills still owe today.',
                  fontSize: s(7),
                  italics: true,
                  margin: [0, s(3), 0, 0],
                },
              ],
              margin: [s(8), s(5), s(8), s(5)],
            },
          ],
          ...(payment.isReversed
            ? [
                [
                  {
                    text:
                      `THIS RECEIPT WAS REVERSED${payment.reversedAt ? ` on ${dmy(pktDayString(payment.reversedAt))}` : ''}` +
                      `${payment.reversalReason ? `: ${payment.reversalReason}` : ''}`,
                    fontSize: s(8.5),
                    bold: true,
                    margin: [s(8), s(5), s(8), s(5)],
                  },
                ],
              ]
            : []),
          [
            {
              columns: [
                {
                  width: '*',
                  stack: [
                    { text: ' ', fontSize: s(8), margin: [0, 0, 0, s(16)] },
                    { text: '_____________________', fontSize: s(8) },
                    { text: 'Received By / School Stamp', fontSize: s(6.5), margin: [0, s(1.5), 0, 0] },
                  ],
                },
                {
                  width: '*',
                  stack: [
                    { text: ' ', fontSize: s(8), margin: [0, 0, 0, s(16)] },
                    { text: '_____________________', fontSize: s(8), alignment: 'right' },
                    { text: 'Payer Signature', fontSize: s(6.5), alignment: 'right', margin: [0, s(1.5), 0, 0] },
                  ],
                },
              ],
              columnGap: 10,
              margin: [s(8), s(6), s(8), s(6)],
            },
          ],
        ] as unknown[]) as never,
      },
      layout: {
        hLineWidth: (i: number, node: { table: { body: unknown[] } }) =>
          i === 0 || i === node.table.body.length ? 1 : 0.5,
        vLineWidth: () => 1,
        hLineColor: () => '#000000',
        vLineColor: () => '#000000',
        paddingLeft: () => 0,
        paddingRight: () => 0,
        paddingTop: () => 0,
        paddingBottom: () => 0,
      },
    },
  ];

  const block = content[0] as unknown as Record<string, unknown>;
  return (pageBreak ? { ...block, pageBreak: 'before' } : block) as unknown as Content;
}

export async function renderPaymentReceiptPdf(
  paymentId: string,
): Promise<{ buffer: Buffer; receiptNo: string }> {
  const [payment, loaded] = await Promise.all([
    prisma.feePayment.findUnique({ where: { id: paymentId }, include: RECEIPT_INCLUDE }),
    loadSchool(),
  ]);
  if (!payment) throw NotFound('Payment not found');

  const buffer = await render({
    pageSize: { width: B6_WIDTH_PT, height: B6_HEIGHT_PT },
    pageOrientation: 'portrait',
    pageMargins: [MARGIN, MARGIN, MARGIN, MARGIN],
    content: [receiptContent(payment, loaded.school, loaded.logoDataUri, false)],
    ...(loaded.logoDataUri ? { images: { logo: loaded.logoDataUri } } : {}),
    defaultStyle: { font: 'Roboto' },
  });
  return { buffer, receiptNo: receiptNoOf(payment.id) };
}

/**
 * Several receipts, one to a sheet.
 *
 * The bulk buttons used to print the CHALLANS behind the selected payments, so
 * two receipts against one challan produced the same page twice and the count
 * never matched what was selected.
 */
export async function renderPaymentReceiptsBatchPdf(ids: string[]): Promise<Buffer> {
  const [payments, loaded] = await Promise.all([
    prisma.feePayment.findMany({
      where: { id: { in: ids } },
      include: RECEIPT_INCLUDE,
      orderBy: { paymentDate: 'desc' },
    }),
    loadSchool(),
  ]);
  if (payments.length === 0) throw NotFound('No matching payments found');

  return render({
    pageSize: { width: B6_WIDTH_PT, height: B6_HEIGHT_PT },
    pageOrientation: 'portrait',
    pageMargins: [MARGIN, MARGIN, MARGIN, MARGIN],
    content: payments.map((p, i) => receiptContent(p, loaded.school, loaded.logoDataUri, i > 0)),
    ...(loaded.logoDataUri ? { images: { logo: loaded.logoDataUri } } : {}),
    defaultStyle: { font: 'Roboto' },
  });
}