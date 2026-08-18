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

/**
 * Build the printable content block for a single challan.
 *
 * Two variants share this function. An UNPAID voucher is one of four on an A4
 * sheet, so it stays tight and unchanged. A settled challan prints as a RECEIPT,
 * alone on a B6 sheet (the paper the school actually loads), so it carries the
 * extra rows a receipt needs — date of payment, total payable, balance due, and
 * a stamp area — at slightly larger type.
 *
 * `scale` is the fit pass's shrink factor and applies to the receipt only: B6 is
 * fixed paper, so a challan carrying an unusual number of arrears lines has to
 * shrink to stay on one sheet rather than grow its page. At the default, an
 * unpaid voucher's measurements are exactly what they have always been.
 */
function voucherBlock(c: ChallanData, school: SchoolInfo, hasLogo: boolean, scale = 1): Content {
  const paidSoFar = Number(c.paidAmount) > 0 ? Number(c.paidAmount) : (Number(c.cashPaid) + Number(c.staffCovered));
  const isPaid = paidSoFar > 0;
  /** Size in points, scaled for the variant. The identity for an unpaid voucher. */
  const s = (n: number) => Math.round(n * (isPaid ? RECEIPT_TYPE_SCALE * scale : 1) * 100) / 100;

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
    fontSize: s(opts.size ?? 8),
    bold: opts.bold ?? false,
    ...(opts.right ? { alignment: 'right' as const } : {}),
    margin: [0, s(opts.pad ?? 3), 0, s(opts.pad ?? 3)],
  });

  const monthName = `${MONTHS[c.month] ?? ''} ${c.year}`.trim();

  const title: Content = {
    text: isPaid ? `PAID FEE VOUCHER — ${monthName.toUpperCase()}` : `UNPAID FEE VOUCHER — ${monthName.toUpperCase()}`,
    fontSize: s(11),
    bold: true,
    alignment: 'center',
    margin: [0, s(4.5), 0, s(4.5)],
  };

  const dateBits: Content[] = [
    { text: [{ text: 'Issued: ', bold: true }, dmy(c.issueDate)], fontSize: s(8) },
    { text: [{ text: 'Due: ', bold: true }, dmy(c.dueDate)], fontSize: s(8), alignment: 'right' },
  ];
  const dates: Content = { columns: dateBits, margin: [s(8), s(4), s(8), s(4)] };

  /** When the money actually arrived — the line a receipt is asked for most. */
  const paymentDate: Content = {
    text: [{ text: 'Date of Payment: ', bold: true }, c.lastPaymentDate ? dmy(c.lastPaymentDate) : '-'],
    fontSize: s(8.5),
    bold: true,
    margin: [s(8), s(3), s(8), s(3)],
  };

  const schoolText: Content = {
    stack: [
      { text: school.name.toUpperCase(), fontSize: s(9.5), bold: true, lineHeight: 1.1 },
      ...(school.address ? [{ text: school.address, fontSize: s(7.5), lineHeight: 1.1 }] : []),
      ...(school.phone ? [{ text: school.phone, fontSize: s(7.5), lineHeight: 1.1 }] : []),
    ],
  };
  const schoolBlock: Content = hasLogo
    ? {
        columns: [
          { image: 'logo', fit: [s(28), s(28)], width: s(30) },
          { ...(schoolText as any), margin: [0, 1, 0, 0] },
        ],
        columnGap: s(6),
        margin: [s(8), s(4.5), s(8), s(4.5)],
      }
    : { ...(schoolText as any), margin: [s(8), s(4.5), s(8), s(4.5)] };

  const kv = (label: string, value: string) => ({
    text: [{ text: `${label}: `, bold: true }, value || '-'],
    fontSize: s(8.5),
    margin: [0, s(1.2), 0, s(1.2)] as [number, number, number, number],
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
    margin: [s(8), s(4.5), s(8), s(4.5)],
  };

  const feeTable: Content = {
    stack: [
      {
        table: {
          headerRows: 1,
          widths: ['*', s(65)],
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
    margin: [s(8), s(4), s(8), s(4)],
  };

  const sumRow = (label: string, value: string, strong = false): Cell[] => [
    T(label, { size: strong ? 8.5 : 8, bold: strong, pad: 2.5 }),
    T(money(value), { size: strong ? 8.5 : 8, bold: strong, right: true, pad: 2.5 }),
  ];

  const payableAfter = Number(c.totalPayable);
  const lateFee = Number(c.lateFee);
  const payableBy = Math.max(0, payableAfter - lateFee);

  /**
   * A receipt answers "what was owed, what was handed over, what is left", so it
   * totals BEFORE any payment and lands on Balance Due. An unpaid voucher
   * answers "what do I pay, and by when", so it keeps its pay-by / after-due
   * pair. The gross is `amount` (base − discount + late fee) plus arrears;
   * subtracting everything received leaves exactly `totalPayable`.
   */
  const grossPayable = Number(c.amount) + Number(c.previousBalance);
  const receiptBody: Cell[][] = [
    sumRow('Fee', c.baseAmount),
    sumRow('Arrears', c.previousBalance),
    sumRow('Late Fee', String(lateFee)),
    sumRow('Discount (−)', c.discount),
    sumRow('TOTAL FEES PAYABLE', String(grossPayable), true),
    sumRow('Fee Paid', c.cashPaid),
    ...(Number(c.staffCovered) > 0 ? [sumRow('Covered from Salary', c.staffCovered)] : []),
    ...(Number(c.advanceCredit) > 0 ? [sumRow('Advance on File', c.advanceCredit)] : []),
    sumRow('BALANCE DUE', c.totalPayable, true),
  ];

  const voucherBody: Cell[][] = [
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

  const summaryBody = isPaid ? receiptBody : voucherBody;
  /** Rule above each strong total: the receipt's two, the voucher's single one. */
  const ruleAt = isPaid ? 4 : summaryBody.length - 3;

  const summary: Content = {
    table: { widths: ['*', s(65)], body: summaryBody },
    layout: {
      hLineWidth: (i: number) => (i === ruleAt || (isPaid && i === summaryBody.length - 1) ? 0.6 : 0),
      vLineWidth: () => 0,
      hLineColor: () => '#000000',
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
    margin: [s(8), s(4), s(8), s(4)],
  };

  /**
   * A receipt is proof of payment: the parent keeps it and the school stamps it,
   * so it needs both hands on it. The gap above each rule is the space someone
   * actually signs and stamps in — sized to be usable by hand, not to fill the
   * page.
   */
  const signature: Content = isPaid
    ? {
        columns: [
          {
            width: '*',
            stack: [
              { text: ' ', fontSize: s(8), margin: [0, 0, 0, s(18)] },
              { text: '_____________________', fontSize: s(8) },
              { text: 'Received By / School Stamp & Signature', fontSize: s(6), margin: [0, s(1.5), 0, 0] },
            ],
          },
          {
            width: '*',
            stack: [
              { text: ' ', fontSize: s(8), margin: [0, 0, 0, s(18)] },
              { text: '_____________________', fontSize: s(8), alignment: 'right' },
              { text: 'Parent / Guardian Signature', fontSize: s(6), alignment: 'right', margin: [0, s(1.5), 0, 0] },
            ],
          },
        ],
        columnGap: s(10),
        margin: [s(8), s(6), s(8), s(6)],
      }
    : {
        text: 'Parent / Guardian Signature: ______________________',
        fontSize: s(8),
        margin: [s(8), s(10), s(8), s(10)],
      };

  const body: Content[][] = isPaid
    ? [[title], [dates], [paymentDate], [schoolBlock], [student], [feeTable], [summary], [signature]]
    : [[title], [dates], [schoolBlock], [student], [feeTable], [summary], [signature]];

  return {
    table: {
      widths: ['*'],
      body: body as any,
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
  scale = 1,
): Content[] {
  const isPaid = challans.length > 0 && challans.every(c => (Number(c.paidAmount) > 0 || (Number(c.cashPaid) + Number(c.staffCovered)) > 0));
  const cols = isPaid ? 1 : 2;
  const pages: Content[] = [];

  for (let i = 0; i < challans.length; i += perPage) {
    const group = challans.slice(i, i + perPage);
    const rows: Content[][] = [];
    for (let r = 0; r < group.length; r += cols) {
      const rowCells: Content[] = group.slice(r, r + cols).map((c) => voucherBlock(c, school, hasLogo, scale));
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
        // A voucher shares its sheet with three others and needs a cutting
        // gutter; a receipt is alone on its B6 page, where that gutter is
        // just unused paper.
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

/**
 * Tell a reader not to resize this document when printing it.
 *
 * The receipt's page is deliberately its own size rather than A4, so a viewer
 * that helpfully scales it "to fit" undoes the point. `/PrintScaling /None` is
 * the standard way to say so, and a `CropBox` equal to the `MediaBox` leaves a
 * reader nothing to infer — the box is only implied by default, and an implied
 * value is one a viewer can decide differently about.
 *
 * Both are set through pdfkit's document object because pdfmake exposes no
 * option for either. `ViewerPreferences` must be a reference: pdfkit calls
 * `.end()` on whatever it finds there. A plain JS string becomes a PDF name,
 * which is what `/None` needs to be.
 */
function stampPageMetadata(pdf: PdfKitDoc): void {
  const doc = pdf as unknown as {
    _root?: { data: Record<string, unknown> };
    _pageBuffer?: Array<{ dictionary: { data: Record<string, unknown> } }>;
    ref?: (data: Record<string, unknown>) => unknown;
  };
  try {
    if (doc._root && typeof doc.ref === 'function') {
      doc._root.data.ViewerPreferences = doc.ref({ PrintScaling: 'None' });
    }
    for (const page of doc._pageBuffer ?? []) {
      if (page.dictionary.data.MediaBox) page.dictionary.data.CropBox = page.dictionary.data.MediaBox;
    }
  } catch {
    // Reaching into pdfkit's internals is a convenience, not a requirement:
    // a PDF without these is still correct, just more open to interpretation.
  }
}

function render(doc: TDocumentDefinitions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = printer.createPdfKitDocument(doc);
    stampPageMetadata(pdf);
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    pdf.end();
  });
}

/** True when every challan in the batch has money against it. */
function allPaid(challans: ChallanData[]): boolean {
  return (
    challans.length > 0 &&
    challans.every((c) => Number(c.paidAmount) > 0 || Number(c.cashPaid) + Number(c.staffCovered) > 0)
  );
}

/**
 * Page geometry for the paid receipt.
 *
 * The school prints paid challans on physical B6 sheets, so the PDF page IS
 * B6 — not A4 trusting the printer to shrink it, and not a bespoke size that
 * happens to be close. PDF user space is points: 72 to the inch, 25.4 mm to
 * the inch, so a millimetre is 72/25.4 points and the conversion is exact
 * rather than a rounded constant someone has to trust.
 *
 * ISO B6 is 125 mm x 176 mm portrait = 354.33 x 498.9 pt.
 */
const MM_TO_PT = 72 / 25.4;
export const B6_WIDTH_PT = 125 * MM_TO_PT;
export const B6_HEIGHT_PT = 176 * MM_TO_PT;

/**
 * B6 gives a receipt more width than the quarter-A4 slot an unpaid voucher
 * lives in, so the receipt's type is set proportionally larger. This is a
 * typographic choice for the paper, not a stretch to consume space — every row
 * keeps its natural height.
 */
const RECEIPT_TYPE_SCALE = 1.32;

/** Trim on a B6 sheet: enough to clear a printer's unprintable edge, no more. */
const RECEIPT_MARGIN = 10;

function pageCount(pdf: Buffer): number {
  const counts = [...pdf.toString('latin1').matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  return counts.length ? Math.max(...counts) : 0;
}

/**
 * Find the largest type scale that still keeps every receipt on its own sheet.
 *
 * The page can no longer grow to fit the content — the paper is a fixed
 * physical size — so when a challan carries an unusual number of arrears lines
 * the type shrinks instead. Nothing is dropped and no row is squashed
 * individually; the whole block scales down together and stays proportional.
 *
 * Normal challans fit at 1 and never enter the loop, so the common path costs
 * one render.
 */
async function fittedScale(
  challans: ChallanData[],
  school: SchoolInfo & { logoDataUri: string | null },
): Promise<number> {
  const wanted = challans.length;
  const STEP = 0.04;
  const MIN = 0.7;
  let scale = 1;
  while (scale > MIN) {
    if (pageCount(await render(voucherDoc(challans, school, scale))) <= wanted) return scale;
    scale = Math.round((scale - STEP) * 100) / 100;
  }
  return MIN;
}

function voucherDoc(
  challans: ChallanData[],
  school: SchoolInfo & { logoDataUri: string | null },
  scale = 1,
): TDocumentDefinitions {
  const perPage = perPageFor(challans);
  const isPaid = allPaid(challans);

  return {
    // A paid receipt is a native B6 page. An unpaid voucher stays A4, 4-up.
    pageSize: isPaid ? { width: B6_WIDTH_PT, height: B6_HEIGHT_PT } : 'A4',
    pageOrientation: 'portrait',
    pageMargins: isPaid
      ? [RECEIPT_MARGIN, RECEIPT_MARGIN, RECEIPT_MARGIN, RECEIPT_MARGIN]
      : [14, 14, 14, 14],
    content: voucherGrid(challans, school, Boolean(school.logoDataUri), perPage, scale),
    ...(school.logoDataUri ? { images: { logo: school.logoDataUri } } : {}),
    defaultStyle: { font: 'Roboto', fontSize: 6 },
  };
}

/**
 * Render already-loaded challans to PDF bytes.
 *
 * Split out from the two id-taking entry points so the real page geometry can
 * be exercised without a database — the page size is the whole point of this
 * module and is worth asserting on the actual bytes.
 */
export async function renderVouchers(
  challans: ChallanData[],
  school: SchoolInfo & { logoDataUri: string | null },
): Promise<Buffer> {
  const scale = allPaid(challans) ? await fittedScale(challans, school) : 1;
  return render(voucherDoc(challans, school, scale));
}

/** Render one challan to a PDF buffer. */
export async function renderChallanPdf(id: string): Promise<{ buffer: Buffer; challanNo: string }> {
  const [c, school] = await Promise.all([getChallan(id), loadSchool()]);
  return { buffer: await renderVouchers([c], school), challanNo: c.challanNo };
}

/** Render many challans into a single PDF, four to an A4 sheet where they fit. */
export async function renderChallansBatchPdf(ids: string[]): Promise<Buffer> {
  const school = await loadSchool();
  const challans = await Promise.all(ids.map((id) => getChallan(id)));
  return renderVouchers(challans, school);
}
