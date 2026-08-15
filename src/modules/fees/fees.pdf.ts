import PdfPrinterModule from 'pdfmake';
import type { TDocumentDefinitions, Content, TFontDictionary } from 'pdfmake/interfaces';

// @types/pdfmake describes the browser build (createPdf) and exposes the module
// as a namespace, not the Node server-side PdfPrinter class. At runtime the
// package's main export IS that class, so we cast to the constructor we get.
type PdfKitDoc = NodeJS.ReadableStream & { end(): void };
const PdfPrinter = PdfPrinterModule as unknown as {
  new (fonts: TFontDictionary): { createPdfKitDocument(doc: TDocumentDefinitions): PdfKitDoc };
};
import { prisma } from '../../config/prisma';
import { getChallan } from './fees.service';
import { fetchFileBuffer } from '../../services/storage';
import { pktDayString } from '../../utils/pktDate';

/**
 * Server-side challan PDF rendering.
 *
 * We map pdfmake's default "Roboto" font family onto the PDF standard-14
 * Helvetica faces. pdfkit resolves those by name from its built-in AFM
 * metrics, so no .ttf files need to ship with the app — the PDF stays small
 * and the build has zero font assets to manage.
 */
const printer = new PdfPrinter({
  Roboto: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
});

const ITEM_LABEL: Record<string, string> = {
  TUITION: 'Tuition (Monthly)',
  TRANSPORT: 'Transport',
  ADMISSION: 'Admission (One-time)',
  EXAM: 'Examination',
  OTHER: 'Other',
};

const MONTHS = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

type ChallanData = Awaited<ReturnType<typeof getChallan>>;
type SchoolInfo = { name: string; address: string | null; phone: string | null; email: string | null };

/** Build the printable content block for a single challan. */
/**
 * One fee voucher, laid out to match the school's existing printed vouchers.
 *
 * Deliberately monochrome and rule-based rather than the app's indigo cards:
 * these are printed in bulk on a shared office printer, colour ink is an
 * expense, and parents already recognise this form. Every figure sits in a
 * ruled box so a voucher stays readable after being folded into a schoolbag.
 */
function paidVoucherBlock(c: ChallanData, school: SchoolInfo, hasLogo: boolean): Content {
  const dmy = (iso: string) => {
    if (!iso) return '-';
    const [y, m, d] = iso.split('-');
    return d && m && y ? `${d}-${m}-${y}` : iso;
  };

  const fmtInt = (val: string | number) => String(Math.round(Number(val || 0)));

  const monthName = MONTHS[c.month] ?? '';
  const paymentDate = c.lastPaymentDate ? dmy(c.lastPaymentDate) : dmy(c.issueDate);

  // 1. Top payment information
  const dateOfPaymentRow: Content = {
    text: [
      { text: 'Date of Payment: ', bold: true, fontSize: 15.31 },
      { text: paymentDate, fontSize: 15.31 },
    ],
    alignment: 'center',
    margin: [0.0, 3.22, 0.0, 9.67],
  };

  const datesTable: Content = {
    table: {
      widths: ['*', '*'],
      body: [
        [
          {
            text: [{ text: 'Issued Date: ', bold: true, fontSize: 13.7 }, dmy(c.issueDate)],
            margin: [9.67, 4.83, 9.67, 4.83],
          },
          {
            text: [{ text: 'Due Date: ', bold: true, fontSize: 13.7 }, dmy(c.dueDate)],
            margin: [9.67, 4.83, 9.67, 4.83],
          },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 1,
      vLineWidth: (i: number) => (i === 1 ? 1 : 1),
      hLineColor: () => '#000000',
      vLineColor: () => '#000000',
    },
  };

  // 2. School identity section
  const schoolDetails: Content[] = [
    { text: school.name.toUpperCase(), fontSize: 16.92, bold: true, margin: [0.0, 0.0, 0.0, 3.22] },
  ];
  if (school.address) {
    const lines = school.address.split('\n');
    lines.forEach((l) => {
      schoolDetails.push({ text: `Address: ${l}`, fontSize: 12.09, margin: [0.0, 0.81, 0.0, 0.81] });
    });
  }
  if (school.phone) {
    schoolDetails.push({ text: school.phone, fontSize: 12.09, margin: [0.0, 0.81, 0.0, 0.81] });
  }

  const schoolBlock: Content = {
    table: {
      widths: hasLogo ? ['*', 55] : ['*'],
      body: [
        [
          { stack: schoolDetails, margin: [9.67, 6.45, 9.67, 6.45] },
          ...(hasLogo
            ? [
                {
                  image: 'logo',
                  // Written as tuples, not arrays: pdfmake's TableCell union
                  // rejects a widened number[] and blames the whole table.
                  fit: [73, 73] as [number, number],
                  alignment: 'right' as const,
                  margin: [3.22, 6.45, 9.67, 6.45] as [number, number, number, number],
                },
              ]
            : []),
        ],
      ],
    },
    layout: {
      hLineWidth: () => 1,
      vLineWidth: () => 1,
      hLineColor: () => '#000000',
      vLineColor: () => '#000000',
    },
  };

  // 3. Student identification section
  const studentHeaderTable: Content = {
    table: {
      widths: ['50%', '50%'],
      body: [
        [
          {
            text: [
              { text: 'Student ID: ', bold: true, fontSize: 13.7 },
              { text: ` ${c.student.admissionNo}`, bold: true, fontSize: 13.7 },
            ],
            margin: [9.67, 4.83, 9.67, 4.83],
          },
          {
            text: [
              { text: 'Voucher No. ', bold: true, fontSize: 13.7 },
              { text: ` ${c.challanNo.replace(/^CH-/, '')}`, bold: true, fontSize: 13.7 },
            ],
            margin: [9.67, 4.83, 9.67, 4.83],
          },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 1,
      vLineWidth: () => 1,
      hLineColor: () => '#000000',
      vLineColor: () => '#000000',
    },
  };

  const studentDetailsTable: Content = {
    table: {
      widths: [153, '*'],
      body: [
        [
          { text: 'Student Name:', bold: true, fontSize: 13.7, margin: [9.67, 4.03, 0.0, 4.03] },
          { text: c.student.name, bold: true, fontSize: 13.7, margin: [0.0, 4.03, 9.67, 4.03] },
        ],
        [
          { text: "Father's Name:", bold: true, fontSize: 13.7, margin: [9.67, 4.03, 0.0, 4.03] },
          { text: c.student.parentName || '-', fontSize: 13.7, margin: [0.0, 4.03, 9.67, 4.03] },
        ],
        [
          { text: 'Class:', bold: true, fontSize: 13.7, margin: [9.67, 4.03, 0.0, 4.03] },
          { text: `${c.student.className} ${c.student.sectionName}`.trim(), fontSize: 13.7, margin: [0.0, 4.03, 9.67, 4.03] },
        ],
      ],
    },
    layout: {
      hLineWidth: (i: number, node: any) => (i === 0 || i === node.table.body.length ? 1 : 0),
      vLineWidth: () => 1,
      hLineColor: () => '#000000',
      vLineColor: () => '#000000',
    },
  };

  // 4. Fee information section
  const feeTypeLabel = c.items.length > 0 ? (c.items[0].label || ITEM_LABEL[c.items[0].type] || 'Monthly Fee') : 'Monthly Fee';

  const feeInfoTable: Content = {
    table: {
      widths: ['*', '*'],
      body: [
        [
          { text: 'Fee Type:', bold: true, fontSize: 13.7, margin: [9.67, 4.03, 0.0, 4.03] },
          { text: feeTypeLabel, alignment: 'right', fontSize: 13.7, margin: [0.0, 4.03, 9.67, 4.03] },
        ],
        [
          { text: 'Month Name:', bold: true, fontSize: 13.7, margin: [9.67, 4.03, 0.0, 4.03] },
          { text: monthName, alignment: 'right', fontSize: 13.7, margin: [0.0, 4.03, 9.67, 4.03] },
        ],
        [
          { text: 'Year:', bold: true, fontSize: 13.7, margin: [9.67, 4.03, 0.0, 4.03] },
          { text: String(c.year), alignment: 'right', fontSize: 13.7, margin: [0.0, 4.03, 9.67, 4.03] },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 1,
      vLineWidth: () => 1,
      hLineColor: () => '#000000',
      vLineColor: () => '#000000',
    },
  };

  // 5. Fee calculation section
  const previousDuesVal = Math.round(Number(c.previousBalance || 0));
  const baseAmountVal = Math.round(Number(c.baseAmount || 0));
  const lateFeeVal = Math.round(Number(c.lateFee || 0));
  const discountVal = Math.round(Number(c.discount || 0));

  const totalPayableVal = Math.max(0, baseAmountVal + previousDuesVal + lateFeeVal - discountVal);
  const paidSoFar = Number(c.paidAmount) > 0 ? Number(c.paidAmount) : (Number(c.cashPaid) + Number(c.staffCovered));
  const paidVal = Math.round(paidSoFar);
  const balanceDueVal = Math.max(0, totalPayableVal - paidVal);

  const feeCalcTable: Content = {
    table: {
      widths: ['*', '*'],
      body: [
        [
          { text: 'Arrears:', bold: true, fontSize: 13.7, margin: [9.67, 4.03, 0.0, 4.03] },
          { text: fmtInt(previousDuesVal), alignment: 'right', fontSize: 13.7, margin: [0.0, 4.03, 9.67, 4.03] },
        ],
        [
          { text: 'Fee:', bold: true, fontSize: 13.7, margin: [9.67, 4.03, 0.0, 4.03] },
          { text: fmtInt(baseAmountVal), alignment: 'right', fontSize: 13.7, margin: [0.0, 4.03, 9.67, 4.03] },
        ],
        [
          { text: 'Late Fee:', bold: true, fontSize: 13.7, margin: [9.67, 4.03, 0.0, 4.03] },
          { text: fmtInt(lateFeeVal), alignment: 'right', fontSize: 13.7, margin: [0.0, 4.03, 9.67, 4.03] },
        ],
        [
          { text: 'Discount Amount:', bold: true, fontSize: 13.7, margin: [9.67, 4.03, 0.0, 4.03] },
          { text: fmtInt(discountVal), alignment: 'right', fontSize: 13.7, margin: [0.0, 4.03, 9.67, 4.03] },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 1,
      vLineWidth: () => 1,
      hLineColor: () => '#000000',
      vLineColor: () => '#000000',
    },
  };

  // 6. Total Fees Payable row
  const totalPayableTable: Content = {
    table: {
      widths: ['*', '*'],
      body: [
        [
          { text: 'Total Fees Payable:', bold: true, fontSize: 14.5, margin: [9.67, 5.64, 0.0, 5.64] },
          { text: fmtInt(totalPayableVal), bold: true, alignment: 'right', fontSize: 14.5, margin: [0.0, 5.64, 9.67, 5.64] },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 1,
      vLineWidth: () => 1,
      hLineColor: () => '#000000',
      vLineColor: () => '#000000',
    },
  };

  // 7. Fee Paid row
  const feePaidTable: Content = {
    table: {
      widths: ['*', '*'],
      body: [
        [
          { text: 'Fee Paid:', bold: true, fontSize: 14.5, margin: [9.67, 5.64, 0.0, 5.64] },
          { text: fmtInt(paidVal), bold: true, alignment: 'right', fontSize: 14.5, margin: [0.0, 5.64, 9.67, 5.64] },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 1,
      vLineWidth: () => 1,
      hLineColor: () => '#000000',
      vLineColor: () => '#000000',
    },
  };

  // 8. Balance Due row
  const balanceDueTable: Content = {
    table: {
      widths: ['*', '*'],
      body: [
        [
          { text: 'Balance Due:', bold: true, fontSize: 14.5, margin: [9.67, 5.64, 0.0, 5.64] },
          { text: fmtInt(balanceDueVal), bold: true, alignment: 'right', fontSize: 14.5, margin: [0.0, 5.64, 9.67, 5.64] },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 1,
      vLineWidth: () => 1,
      hLineColor: () => '#000000',
      vLineColor: () => '#000000',
    },
  };

  return {
    stack: [
      dateOfPaymentRow,
      datesTable,
      schoolBlock,
      studentHeaderTable,
      studentDetailsTable,
      feeInfoTable,
      feeCalcTable,
      totalPayableTable,
      feePaidTable,
      balanceDueTable,
      /*
       * Scaling to A4's width still leaves roughly a fifth of the sheet: the
       * receipt is nearly square (0.916) and A4 is not (0.707), and uniform
       * scaling can never fill both axes. A signature and stamp band is what a
       * handed-over receipt needs anyway, so the remaining height carries
       * something rather than being padded out.
       */
      {
        table: {
          widths: ['*', '*'],
          heights: [70],
          body: [
            [
              {
                stack: [
                  { text: 'Received By', bold: true, fontSize: 12, margin: [10, 8, 0, 0] },
                  { text: '(School Stamp & Signature)', fontSize: 9, color: '#555555', margin: [10, 2, 0, 0] },
                ],
              },
              {
                stack: [
                  { text: 'Parent / Guardian', bold: true, fontSize: 12, alignment: 'right', margin: [0, 8, 10, 0] },
                  { text: '(Signature)', fontSize: 9, color: '#555555', alignment: 'right', margin: [0, 2, 10, 0] },
                ],
              },
            ],
          ],
        },
        layout: {
          hLineWidth: () => 1,
          vLineWidth: () => 1,
          hLineColor: () => '#000000',
          vLineColor: () => '#000000',
          paddingLeft: () => 0,
          paddingRight: () => 0,
          paddingTop: () => 0,
          paddingBottom: () => 0,
        },
      },
    ],
  };
}

/** Build the printable content block for a single challan. */
function voucherBlock(c: ChallanData, school: SchoolInfo, hasLogo: boolean): Content {
  const paidSoFar = Number(c.paidAmount) > 0 ? Number(c.paidAmount) : (Number(c.cashPaid) + Number(c.staffCovered));
  if (paidSoFar > 0) {
    return paidVoucherBlock(c, school, hasLogo);
  }

  const money = (v: string | number) => Number(v).toLocaleString('en-PK');
  /** YYYY-MM-DD to the DD-MM-YYYY the school's own vouchers use. */
  const dmy = (iso: string) => {
    const [y, m, d] = iso.split('-');
    return d && m && y ? `${d}-${m}-${y}` : iso;
  };

  const lines: { label: string; amount: string }[] = [
    ...c.items.map((it) => ({
      label: `${MONTHS[c.month] ?? ''} ${c.year} — ${it.label || ITEM_LABEL[it.type] || it.type}`,
      amount: String(it.amount),
    })),
    ...c.previousDues.map((d) => ({
      label: `${MONTHS[d.month] ?? ''} ${d.year} (UNPAID) — Previous Due${d.staffBilled ? ' (salary)' : ''}`,
      amount: String(d.balance),
    })),
  ];

  type Cell = {
    text: string;
    fontSize: number;
    bold: boolean;
    alignment?: 'left' | 'right' | 'center';
    margin: [number, number, number, number];
  };
  const T = (
    text: string,
    opts: { size?: number; bold?: boolean; right?: boolean; pad?: number } = {},
  ): Cell => ({
    text,
    fontSize: opts.size ?? 8,
    bold: opts.bold ?? false,
    ...(opts.right ? { alignment: 'right' as const } : {}),
    margin: [0, opts.pad ?? 3, 0, opts.pad ?? 3],
  });

  const monthName = `${MONTHS[c.month] ?? ''} ${c.year}`.trim();

  const title: Content = {
    text: `FEE VOUCHER — ${monthName.toUpperCase()}`,
    fontSize: 11,
    bold: true,
    alignment: 'center',
    margin: [0, 4.5, 0, 4.5],
  };

  const dateBits: Content[] = [
    { text: [{ text: 'Issued: ', bold: true }, dmy(c.issueDate)], fontSize: 8 },
    { text: [{ text: 'Due: ', bold: true }, dmy(c.dueDate)], fontSize: 8, alignment: 'right' },
  ];
  const dates: Content = { columns: dateBits, margin: [8, 4, 8, 4] };

  const schoolText: Content = {
    stack: [
      { text: school.name.toUpperCase(), fontSize: 9.5, bold: true, lineHeight: 1.1 },
      ...(school.address ? [{ text: school.address, fontSize: 7.5, lineHeight: 1.1 }] : []),
      ...(school.phone ? [{ text: school.phone, fontSize: 7.5, lineHeight: 1.1 }] : []),
    ],
  };
  const schoolBlock: Content = hasLogo
    ? {
        columns: [
          { image: 'logo', fit: [28, 28], width: 30 },
          { ...(schoolText as any), margin: [0, 1, 0, 0] },
        ],
        columnGap: 6,
        margin: [8, 4.5, 8, 4.5],
      }
    : { ...(schoolText as any), margin: [8, 4.5, 8, 4.5] };

  const kv = (label: string, value: string) => ({
    text: [{ text: `${label}: `, bold: true }, value || '-'],
    fontSize: 8.5,
    margin: [0, 1.2, 0, 1.2] as [number, number, number, number],
  });

  const student: Content = {
    stack: [
      {
        columns: [
          kv('Student ID', c.student.admissionNo),
          { ...kv('Voucher', c.challanNo.replace(/^CH-/, '')), alignment: 'right' },
        ],
      },
      kv('Student', c.student.name),
      kv('Father', c.student.parentName ?? ''),
      {
        columns: [
          kv('Class', `${c.student.className} ${c.student.sectionName}`.trim()),
          { ...kv('Fee Month', monthName), alignment: 'right' },
        ],
      },
    ],
    margin: [8, 4.5, 8, 4.5],
  };

  const feeTable: Content = {
    stack: [
      {
        table: {
          headerRows: 1,
          widths: ['*', 65],
          body: [
            [
              T('Fee Description', { size: 8, bold: true, pad: 2.5 }),
              T('Amount', { size: 8, bold: true, right: true, pad: 2.5 }),
            ],
            ...lines.map((l) => [T(l.label), T(money(l.amount), { right: true })]),
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
      },
    ],
    margin: [8, 4, 8, 4],
  };

  const sumRow = (label: string, value: string, strong = false): Cell[] => [
    T(label, { size: strong ? 8.5 : 8, bold: strong, pad: 2.5 }),
    T(money(value), { size: strong ? 8.5 : 8, bold: strong, right: true, pad: 2.5 }),
  ];

  const payableAfter = Number(c.totalPayable);
  const lateFee = Number(c.lateFee);
  const payableBy = Math.max(0, payableAfter - lateFee);

  const summaryBody: Cell[][] = [
    sumRow('Subtotal', c.baseAmount),
    sumRow('Previous Dues', c.previousBalance),
    sumRow('Discount', c.discount),
    ...(Number(c.cashPaid) > 0 ? [sumRow('Fee Paid', c.cashPaid)] : []),
    ...(Number(c.staffCovered) > 0 ? [sumRow('Covered from Salary', c.staffCovered)] : []),
    ...(Number(c.advanceCredit) > 0 ? [sumRow('Advance on File', c.advanceCredit)] : []),
    sumRow(`PAYABLE BY ${dmy(c.dueDate)}`, String(payableBy), true),
    sumRow('Late Fee', String(lateFee)),
    sumRow('PAYABLE AFTER DUE DATE', String(payableAfter), true),
  ];
  const ruleAt = summaryBody.length - 3;

  const summary: Content = {
    table: { widths: ['*', 65], body: summaryBody },
    layout: {
      hLineWidth: (i: number) => (i === ruleAt ? 0.6 : 0),
      vLineWidth: () => 0,
      hLineColor: () => '#000000',
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
    margin: [8, 4, 8, 4],
  };

  const signature: Content = {
    text: 'Parent / Guardian Signature: ______________________',
    fontSize: 8,
    margin: [8, 10, 8, 10],
  };

  return {
    table: {
      widths: ['*'],
      body: [[title], [dates], [schoolBlock], [student], [feeTable], [summary], [signature]],
    },
    layout: {
      hLineWidth: (i: number, node: any) => (i === 0 || i === node.table.body.length ? 1 : 0.5),
      vLineWidth: () => 1,
      hLineColor: () => '#000000',
      vLineColor: () => '#000000',
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
  };
}

/**
 * How many vouchers fit on one A4 sheet.
 *
 * Fixed at 4 vouchers per A4 sheet (2 columns × 2 rows), matching shipping label density
 * so each challan occupies a comfortable A6-sized quadrant with clear, readable typography.
 */
export function perPageFor(
  challans: Array<Partial<Pick<ChallanData, 'items' | 'previousDues' | 'paidAmount' | 'cashPaid' | 'staffCovered'>>>,
): number {
  const isPaid = challans.length > 0 && challans.every(c => (Number(c.paidAmount || 0) > 0 || (Number(c.cashPaid || 0) + Number(c.staffCovered || 0)) > 0));
  return isPaid ? 1 : 4;
}

/** Lay vouchers out in a grid, 4 per A4 sheet (2x2) or 1 per page for receipts. */
function voucherGrid(
  challans: ChallanData[],
  school: SchoolInfo,
  hasLogo: boolean,
  perPage: number = 4,
): Content[] {
  const isPaid = challans.length > 0 && challans.every(c => (Number(c.paidAmount) > 0 || (Number(c.cashPaid) + Number(c.staffCovered)) > 0));
  const cols = isPaid ? 1 : 2;
  const pages: Content[] = [];

  for (let i = 0; i < challans.length; i += perPage) {
    const group = challans.slice(i, i + perPage);
    const rows: Content[][] = [];
    for (let r = 0; r < group.length; r += cols) {
      const rowCells: Content[] = group.slice(r, r + cols).map((c) => voucherBlock(c, school, hasLogo));
      // Pad a short last row so a lone voucher keeps its column width instead
      // of stretching across the sheet.
      while (rowCells.length < cols) rowCells.push({ text: '' });
      rows.push(rowCells);
    }

    const widths = cols === 2 ? ['*', '*'] : ['*'];

    pages.push({
      table: { widths, body: rows as any },
      layout: {
        hLineWidth: () => 0,
        vLineWidth: () => 0,
        paddingLeft: () => (isPaid ? 0 : 6),
        paddingRight: () => (isPaid ? 0 : 6),
        paddingTop: () => (isPaid ? 0 : 8),
        paddingBottom: () => (isPaid ? 0 : 18),
      },
      ...(i + perPage < challans.length ? { pageBreak: 'after' as const } : {}),
    });
  }
  return pages;
}

async function loadSchool(): Promise<SchoolInfo & { logoDataUri: string | null }> {
  const s = await prisma.school.findFirst();
  const logo = await fetchFileBuffer(s?.logoUrl);
  return {
    name: s?.name ?? 'School',
    address: s?.address ?? null,
    phone: s?.phone ?? null,
    email: s?.email ?? null,
    logoDataUri: logo ? `data:${logo.contentType};base64,${logo.buffer.toString('base64')}` : null,
  };
}

function render(doc: TDocumentDefinitions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = printer.createPdfKitDocument(doc);
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    pdf.end();
  });
}

function voucherDoc(
  challans: ChallanData[],
  school: SchoolInfo & { logoDataUri: string | null },
): TDocumentDefinitions {
  const perPage = perPageFor(challans);
  const isPaid = challans.length > 0 && challans.every(c => (Number(c.paidAmount) > 0 || (Number(c.cashPaid) + Number(c.staffCovered)) > 0));

  /*
   * A paid receipt prints one to a sheet, so its page must BE the sheet.
   *
   * It used to be sized to hug its content (380 x 415pt, aspect 0.916). A
   * browser's "fit to paper" scales a page uniformly, so a page whose shape
   * differs from the paper is letterboxed however the print dialog is set —
   * 0.916 against A4's 0.707 left about a fifth of the sheet blank and blew
   * the type up 1.6x, which is what made it look coarse. Generating at true A4
   * makes that scaling 1:1.
   */

  return {
    pageSize: process.env.PROBE_H ? { width: 595.28, height: Number(process.env.PROBE_H) } : 'A4',
    /*
     * A proper margin for the receipt, which is handed to a parent: a document
     * pressed against the paper edge reads as a printout rather than a receipt.
     * The 4-up vouchers keep the tight margin, since they are cut apart.
     */
    pageMargins: isPaid ? [28, 28, 28, 28] : [14, 14, 14, 14],
    content: voucherGrid(challans, school, Boolean(school.logoDataUri), perPage),
    ...(school.logoDataUri ? { images: { logo: school.logoDataUri } } : {}),
    defaultStyle: { font: 'Roboto', fontSize: 6 },
  };
}

/** Render one challan to a PDF buffer. */
export async function renderChallanPdf(id: string): Promise<{ buffer: Buffer; challanNo: string }> {
  const [c, school] = await Promise.all([getChallan(id), loadSchool()]);
  const buffer = await render(voucherDoc([c], school));
  return { buffer, challanNo: c.challanNo };
}

/** Render many challans into a single PDF, four to an A4 sheet where they fit. */
export async function renderChallansBatchPdf(ids: string[]): Promise<Buffer> {
  const school = await loadSchool();
  const challans = await Promise.all(ids.map((id) => getChallan(id)));
  return render(voucherDoc(challans, school));
}
