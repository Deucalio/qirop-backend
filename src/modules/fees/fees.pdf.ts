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
/** Build the printable content block for a single challan. */
function voucherBlock(c: ChallanData, school: SchoolInfo, hasLogo: boolean): Content {
  const paidSoFar = Number(c.paidAmount) > 0 ? Number(c.paidAmount) : (Number(c.cashPaid) + Number(c.staffCovered));

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
    text: paidSoFar > 0 ? `PAID FEE VOUCHER — ${monthName.toUpperCase()}` : `FEE VOUCHER — ${monthName.toUpperCase()}`,
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
        paddingLeft: () => 6,
        paddingRight: () => 6,
        paddingTop: () => 8,
        paddingBottom: () => 18,
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

const RECEIPT_WIDTH = 595.28; // the width the receipt is laid out for
const RECEIPT_MARGIN = 40;

function voucherDoc(
  challans: ChallanData[],
  school: SchoolInfo & { logoDataUri: string | null },
): TDocumentDefinitions {
  const perPage = perPageFor(challans);
  const isPaid = allPaid(challans);

  return {
    pageSize: isPaid ? 'A6' : 'A4',
    pageOrientation: 'portrait',
    pageMargins: [14, 14, 14, 14],
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
