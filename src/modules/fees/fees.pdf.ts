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
  const money = (v: string | number) => Number(v).toLocaleString('en-PK');
  /** YYYY-MM-DD to the DD-MM-YYYY the school's own vouchers use. */
  const dmy = (iso: string) => {
    const [y, m, d] = iso.split('-');
    return d && m && y ? `${d}-${m}-${y}` : iso;
  };

  const settled = Number(c.balance) <= 0 && Number(c.paidAmount) > 0;
  const statusTag = settled ? ' (PAID)' : Number(c.paidAmount) > 0 ? ' (PARTIAL)' : '';

  /*
   * One line per thing being charged. The month is folded into the description
   * rather than given a column of its own: "August 2026 Monthly Fee" reads as a
   * sentence and costs a third of the width a separate Month column did.
   */
  const lines: { label: string; amount: string }[] = [
    ...c.items.map((it) => ({
      label: `${MONTHS[c.month] ?? ''} ${c.year}${statusTag} — ${it.label || ITEM_LABEL[it.type] || it.type}`,
      amount: String(it.amount),
    })),
    ...c.previousDues.map((d) => ({
      label: `${MONTHS[d.month] ?? ''} ${d.year}${settled ? ' (PAID)' : ''} — Previous Due${d.staffBilled ? ' (salary)' : ''}`,
      amount: String(d.balance),
    })),
  ];

  /**
   * A table cell. Written out rather than inferred because pdfmake's TableCell
   * union rejects a widened `number[]` margin or a `string` alignment, and the
   * resulting error points at the whole table rather than the cell.
   */
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

  /* ---- header: title, then dates on one line ------------------------- */
  const title: Content = {
    text: `${settled ? 'FEE RECEIPT (PAID)' : 'FEE VOUCHER'} — ${monthName.toUpperCase()}`,
    fontSize: 11,
    bold: true,
    alignment: 'center',
    margin: [0, 4.5, 0, 4.5],
  };

  const dateBits: Content[] = [
    { text: [{ text: 'Issued: ', bold: true }, dmy(c.issueDate)], fontSize: 8 },
    { text: [{ text: 'Due: ', bold: true }, dmy(c.dueDate)], fontSize: 8, alignment: 'right' },
  ];
  // Only a paid voucher has a payment date, so only a receipt shows one.
  if (settled && c.lastPaymentDate) {
    dateBits.splice(1, 0, {
      text: [{ text: 'Paid: ', bold: true }, dmy(c.lastPaymentDate)],
      fontSize: 8,
      alignment: 'center',
    });
  }
  const dates: Content = { columns: dateBits, margin: [8, 4, 8, 4] };

  /* ---- school block: logo and text share the same band ---------------- */
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

  /* ---- student: labels inline, voucher number beside the ID ----------- */
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
          { ...kv(settled ? 'Paid Month' : 'Fee Month', `${monthName}${statusTag}`), alignment: 'right' },
        ],
      },
    ],
    margin: [8, 4.5, 8, 4.5],
  };

  /* ---- fee details: description and amount, nothing else -------------- */
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
        // Horizontal rules only: a vertical line between description and amount
        // adds ink without adding meaning.
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

  /*
   * Visual hierarchy for Fee Summary:
   * A paid receipt highlights FEE PAID and BALANCE DUE (de-emphasising payable-after/late fee),
   * while an unpaid voucher lists due date surcharges.
   */
  const payableAfter = Number(c.totalPayable);
  const lateFee = Number(c.lateFee);
  const payableBy = Math.max(0, payableAfter - lateFee);

  let summaryBody: Cell[][];
  let ruleAt: number;

  if (settled) {
    const totalPaid = Number(c.paidAmount) > 0 ? c.paidAmount : String(Number(c.cashPaid) + Number(c.staffCovered));
    summaryBody = [
      sumRow('Total Fee', c.baseAmount),
      sumRow('Previous Dues', c.previousBalance),
      sumRow('Discount', c.discount),
      sumRow('FEE PAID', String(totalPaid), true),
      sumRow('BALANCE DUE', String(c.balance), true),
    ];
    ruleAt = summaryBody.length - 2;
  } else {
    summaryBody = [
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
    ruleAt = summaryBody.length - 3;
  }

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

  /* ---- assemble ------------------------------------------------------- */
  return {
    table: {
      widths: ['*'],
      body: [[title], [dates], [schoolBlock], [student], [feeTable], [summary], [signature]],
    },
    // One heavy frame, lighter rules between sections, nothing inside them.
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
export function perPageFor(_challans: Pick<ChallanData, 'items' | 'previousDues'>[]): 4 {
  return 4;
}

/** Lay vouchers out in a grid, 4 per A4 sheet (2x2). */
function voucherGrid(
  challans: ChallanData[],
  school: SchoolInfo,
  hasLogo: boolean,
  perPage: 4 = 4,
): Content[] {
  const cols = 2;
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
      table: { widths: ['*', '*'], body: rows as any },
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
