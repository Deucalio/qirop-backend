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
function voucherBlock(c: ChallanData, school: SchoolInfo, hasLogo: boolean): Content {
  const dash = (v: string) => (v && v.trim() ? v : '-');
  const money = (v: string | number) => Number(v).toLocaleString('en-PK');

  // Every line the parent is being asked to pay: this month's own charges,
  // then each earlier unpaid month brought forward. Numbered as one sequence,
  // so "S.No" counts what is on the voucher rather than what is in the table.
  const lines: { feeType: string; month: string; voucherNo: string; amount: string }[] = [
    ...c.items.map((it) => ({
      feeType: it.label || ITEM_LABEL[it.type] || it.type,
      month: `${(MONTHS[c.month] ?? '').slice(0, 3)} ${c.year}`,
      voucherNo: c.challanNo.replace(/^CH-/, ''),
      amount: String(it.amount),
    })),
    ...c.previousDues.map((d) => ({
      feeType: d.staffBilled ? 'Previous Due (salary)' : 'Previous Due',
      month: `${(MONTHS[d.month] ?? '').slice(0, 3)} ${d.year}`,
      voucherNo: d.challanNo.replace(/^CH-/, ''),
      amount: String(d.balance),
    })),
  ];

  const cell = (
    text: string,
    opts: { bold?: boolean; alignment?: 'left' | 'right' | 'center' } = {},
  ) => ({
    text,
    fontSize: 6,
    bold: opts.bold ?? false,
    alignment: opts.alignment ?? ('left' as const),
    margin: [2, 1.5, 2, 1.5] as [number, number, number, number],
  });

  const GRID = {
    hLineWidth: () => 0.5,
    vLineWidth: () => 0.5,
    hLineColor: () => '#000000',
    vLineColor: () => '#000000',
    paddingLeft: () => 1,
    paddingRight: () => 1,
    paddingTop: () => 0,
    paddingBottom: () => 0,
  };

  const duesTable: Content = {
    table: {
      headerRows: 1,
      widths: [12, 28, '*', 32, 34],
      body: [
        [
          cell('S.No', { bold: true, alignment: 'center' }),
          cell('V.No', { bold: true, alignment: 'center' }),
          cell('Fee Type', { bold: true }),
          cell('Month', { bold: true, alignment: 'center' }),
          cell('Current Fee', { bold: true, alignment: 'right' }),
        ],
        ...lines.map((l, i) => [
          cell(String(i + 1), { alignment: 'center' }),
          cell(l.voucherNo, { alignment: 'center' }),
          cell(l.feeType),
          cell(l.month, { alignment: 'center' }),
          cell(money(l.amount), { alignment: 'right' }),
        ]),
      ],
    },
    layout: GRID,
  };

  /*
   * The late fee reads as the surcharge that applies once the due date passes,
   * which is how the school's own vouchers are written, so "within date"
   * excludes it and "after due date" includes it. Both are derived from the
   * same stored total rather than invented, so the two figures always
   * reconcile against the ledger.
   */
  const payableAfter = Number(c.totalPayable);
  const lateFee = Number(c.lateFee);
  const payableWithin = Math.max(0, payableAfter - lateFee);

  const totalRow = (label: string, value: string, bold = false) => [
    {
      text: label,
      fontSize: 6,
      bold,
      alignment: 'right' as const,
      margin: [2, 1.5, 2, 1.5] as [number, number, number, number],
      colSpan: 4,
    },
    { text: '' },
    { text: '' },
    { text: '' },
    {
      text: value,
      fontSize: 6,
      bold,
      alignment: 'right' as const,
      margin: [2, 1.5, 2, 1.5] as [number, number, number, number],
    },
  ];

  const totalsTable: Content = {
    table: {
      widths: [12, 28, '*', 32, 34],
      body: [
        totalRow('Total', money(c.baseAmount)),
        totalRow('Previous Dues', money(c.previousBalance)),
        totalRow('Discount', money(c.discount)),
        ...(Number(c.cashPaid) > 0 ? [totalRow('Fee Paid', money(c.cashPaid))] : []),
        ...(Number(c.staffCovered) > 0 ? [totalRow('Covered from Salary', money(c.staffCovered))] : []),
        ...(Number(c.advanceCredit) > 0 ? [totalRow('Advance on File', money(c.advanceCredit))] : []),
        totalRow('Payable within Date', money(payableWithin), true),
        totalRow('Late Fee', money(lateFee)),
        totalRow('Payable After Due Date', money(payableAfter), true),
      ],
    },
    layout: {
      ...GRID,
      vLineWidth: (i: number, node: any) => (i === 0 || i === node.table.widths.length ? 0.5 : 0),
    },
  };

  const datesRow: Content = {
    table: {
      widths: ['auto', '*', 'auto', '*'],
      body: [
        [
          cell('Issue Date', { bold: true }),
          cell(pktDayString(c.issueDate), { alignment: 'center' }),
          cell('Due Date', { bold: true }),
          cell(c.dueDate, { alignment: 'center' }),
        ],
      ],
    },
    layout: GRID,
  };

  const schoolText: Content = {
    stack: [
      { text: school.name.toUpperCase(), fontSize: 7, bold: true, lineHeight: 1 },
      ...(school.address ? [{ text: `Address: ${school.address}`, fontSize: 5.5, lineHeight: 1 }] : []),
      ...(school.phone ? [{ text: school.phone, fontSize: 5.5, lineHeight: 1 }] : []),
    ],
  };

  const schoolBlock: Content = hasLogo
    ? {
        columns: [{ image: 'logo', fit: [32, 32], width: 34 }, schoolText],
        columnGap: 4,
        margin: [3, 3, 3, 3],
      }
    : { ...(schoolText as any), margin: [3, 3, 3, 3] };

  const infoLine = (label: string, value: string) => [
    { text: label, fontSize: 6, bold: true, margin: [3, 1, 2, 1] as [number, number, number, number] },
    { text: value, fontSize: 6, margin: [2, 1, 3, 1] as [number, number, number, number] },
  ];

  const studentInfo: Content = {
    table: {
      widths: [56, '*'],
      body: [
        infoLine('Student ID', c.student.admissionNo),
        infoLine('Student Name', dash(c.student.name)),
        infoLine("Father's Name", dash(c.student.parentName ?? '')),
        infoLine('Class', `${c.student.className} ${c.student.sectionName}`.trim()),
      ],
    },
    layout: 'noBorders',
  };

  return {
    table: {
      widths: ['*'],
      body: [
        [{ text: 'FEE VOUCHER', fontSize: 7.5, bold: true, alignment: 'center', margin: [0, 2, 0, 2] }],
        [datesRow],
        [schoolBlock],
        [studentInfo],
        [duesTable],
        [totalsTable],
      ],
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
 * Six fit comfortably in two columns of three when every voucher is a line or
 * two, which is the usual shape of a monthly run. A voucher grows with its
 * dues lines though, so the sheet steps down to four, two, then one rather
 * than clipping a student carrying months of arrears.
 *
 * The whole document uses ONE layout, chosen by the largest voucher in the
 * batch: these are printed to be cut apart by hand, and a sheet of mixed sizes
 * has no straight line to cut along.
 */
export function perPageFor(challans: Pick<ChallanData, 'items' | 'previousDues'>[]): 1 | 2 | 4 | 6 {
  const maxLines = Math.max(0, ...challans.map((c) => c.items.length + c.previousDues.length));
  if (maxLines <= 4) return 6;
  if (maxLines <= 11) return 4;
  if (maxLines <= 24) return 2;
  return 1;
}

/** Lay vouchers out in a grid, `perPage` to an A4 sheet. */
function voucherGrid(
  challans: ChallanData[],
  school: SchoolInfo,
  hasLogo: boolean,
  perPage: 1 | 2 | 4 | 6,
): Content[] {
  const cols = perPage >= 4 ? 2 : 1;
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

    pages.push({
      table: { widths: cols === 2 ? ['*', '*'] : ['*'], body: rows as any },
      layout: {
        hLineWidth: () => 0,
        vLineWidth: () => 0,
        paddingLeft: () => 3,
        paddingRight: () => 3,
        paddingTop: () => 3,
        paddingBottom: () => 10,
      },
      ...(i + perPage < challans.length ? { pageBreak: 'after' as const } : {}),
    });
  }
  return pages;
}

async function loadSchool(): Promise<SchoolInfo & { logoDataUri: string | null }> {
  const s = await prisma.school.findFirst();
  /*
   * The renderer cannot fetch a URL, so the logo travels as bytes. Defined once
   * in the document's `images` dictionary and referenced by name, it is
   * embedded a single time no matter how many vouchers the sheet carries.
   * A missing logo costs the voucher its letterhead, never the print run.
   */
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

/**
 * Build the document. Margins are tight because a voucher is cut out of the
 * sheet, so page edges are waste rather than white space.
 */
function voucherDoc(
  challans: ChallanData[],
  school: SchoolInfo & { logoDataUri: string | null },
): TDocumentDefinitions {
  const perPage = perPageFor(challans);
  return {
    pageSize: 'A4',
    pageMargins: [14, 14, 14, 14],
    content: voucherGrid(challans, school, Boolean(school.logoDataUri), perPage),
    ...(school.logoDataUri ? { images: { logo: school.logoDataUri } } : {}),
    defaultStyle: { font: 'Roboto', fontSize: 6 },
  };
}

/** Render one challan to a PDF buffer. */
export async function renderChallanPdf(id: string): Promise<{ buffer: Buffer; challanNo: string }> {
  const [c, school] = await Promise.all([getChallan(id), loadSchool()]);
  // Deliberately still a quarter of the sheet rather than blown up to fill it:
  // one voucher printed alone should be the same size as one from a batch, so
  // the office cuts and files them identically.
  const buffer = await render(voucherDoc([c], school));
  return { buffer, challanNo: c.challanNo };
}

/** Render many challans into a single PDF, four to an A4 sheet where they fit. */
export async function renderChallansBatchPdf(ids: string[]): Promise<Buffer> {
  const school = await loadSchool();
  const challans = await Promise.all(ids.map((id) => getChallan(id)));
  return render(voucherDoc(challans, school));
}
