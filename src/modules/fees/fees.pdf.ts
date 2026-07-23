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
import { formatPKR } from '../../utils/money';

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

const BRAND = '#4f46e5'; // indigo — matches the app's primary
const INK = '#1e293b';
const MUTED = '#64748b';
const LINE = '#e2e8f0';

const STATUS_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  PAID: { bg: '#dcfce7', fg: '#166534', label: 'PAID' },
  PARTIAL: { bg: '#fef9c3', fg: '#854d0e', label: 'PARTIALLY PAID' },
  UNPAID: { bg: '#f1f5f9', fg: '#475569', label: 'UNPAID' },
  OVERDUE: { bg: '#fee2e2', fg: '#991b1b', label: 'OVERDUE' },
};

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
function challanContent(c: ChallanData, school: SchoolInfo): { stack: Content[] } {
  const status = STATUS_STYLE[c.status] ?? STATUS_STYLE.UNPAID;
  const contactBits = [school.phone, school.email].filter(Boolean).join('  •  ');

  const itemRows = c.items.map((it) => [
    { text: it.label || ITEM_LABEL[it.type] || it.type, style: 'cell' },
    { text: ITEM_LABEL[it.type] ?? it.type, style: 'cellMuted' },
    { text: formatPKR(it.amount), style: 'cellNum' },
  ]);

  // Totals ladder: base → (− discount) → (+ late fee) → payable.
  const totalsRows: Content[] = [];
  const pushTotal = (label: string, value: string, opts: { strong?: boolean; color?: string } = {}) =>
    totalsRows.push({
      columns: [
        { text: label, style: 'totLabel', color: opts.color, bold: opts.strong },
        { text: value, style: 'totVal', color: opts.color, bold: opts.strong },
      ],
      margin: [0, 2, 0, 2],
    });

  pushTotal('Sub-total', formatPKR(c.baseAmount));
  if (Number(c.discount) > 0) pushTotal('Discount', `− ${formatPKR(c.discount)}`, { color: '#16a34a' });
  if (Number(c.lateFee) > 0) pushTotal('Late fee', `+ ${formatPKR(c.lateFee)}`, { color: '#dc2626' });
  totalsRows.push({ canvas: [{ type: 'line', x1: 0, y1: 2, x2: 200, y2: 2, lineWidth: 1, lineColor: LINE }] });
  pushTotal('Total payable', formatPKR(c.amount), { strong: true, color: INK });
  if (Number(c.cashPaid) > 0) pushTotal('Received (cash/bank)', `− ${formatPKR(c.cashPaid)}`, { color: MUTED });
  if (Number(c.staffCovered) > 0)
    pushTotal('Covered from salary', `− ${formatPKR(c.staffCovered)}`, { color: '#7c3aed' });
  totalsRows.push({ canvas: [{ type: 'line', x1: 0, y1: 2, x2: 200, y2: 2, lineWidth: 1, lineColor: LINE }] });
  pushTotal('Balance due', formatPKR(c.balance), {
    strong: true,
    color: Number(c.balance) > 0 ? '#dc2626' : '#16a34a',
  });

  const block: Content[] = [
    // Header band
    {
      columns: [
        [
          { text: school.name, style: 'schoolName' },
          { text: school.address ?? '', style: 'schoolMeta' },
          { text: contactBits, style: 'schoolMeta' },
        ],
        [
          { text: 'FEE CHALLAN', style: 'docTitle', alignment: 'right' },
          { text: `No. ${c.challanNo}`, style: 'docNo', alignment: 'right' },
          {
            table: {
              body: [[{ text: status.label, style: 'badge', fillColor: status.bg, color: status.fg }]],
            },
            layout: 'noBorders',
            alignment: 'right',
            margin: [0, 6, 0, 0],
          },
        ],
      ],
    },
    { canvas: [{ type: 'line', x1: 0, y1: 8, x2: 515, y2: 8, lineWidth: 2, lineColor: BRAND }], margin: [0, 6, 0, 10] },

    // Student + billing meta
    {
      columns: [
        {
          width: '*',
          stack: [
            { text: 'BILL TO', style: 'label' },
            { text: c.student.name, style: 'value' },
            { text: `Admission No: ${c.student.admissionNo}`, style: 'metaSm' },
            { text: `Class: ${c.student.className} — ${c.student.sectionName}`, style: 'metaSm' },
            { text: `Guardian: ${c.student.parentName}`, style: 'metaSm' },
          ],
        },
        {
          width: 'auto',
          stack: [
            { text: 'BILLING PERIOD', style: 'label', alignment: 'right' },
            { text: `${MONTHS[c.month]} ${c.year}`, style: 'value', alignment: 'right' },
            { text: `Issued: ${c.issueDate}`, style: 'metaSm', alignment: 'right' },
            { text: `Due: ${c.dueDate}`, style: 'metaSm', alignment: 'right' },
          ],
        },
      ],
      margin: [0, 0, 0, 12],
    },

    // Items table
    {
      table: {
        headerRows: 1,
        widths: ['*', 'auto', 'auto'],
        body: [
          [
            { text: 'Description', style: 'th' },
            { text: 'Type', style: 'th' },
            { text: 'Amount', style: 'th', alignment: 'right' },
          ],
          ...itemRows,
        ],
      },
      layout: {
        hLineWidth: (i: number, node: { table: { body: unknown[] } }) =>
          i === 0 || i === 1 || i === node.table.body.length ? 1 : 0.5,
        vLineWidth: () => 0,
        hLineColor: (i: number) => (i === 1 ? BRAND : LINE),
        paddingTop: () => 6,
        paddingBottom: () => 6,
      },
      margin: [0, 0, 0, 10],
    },

    // Totals — right aligned column
    { columns: [{ width: '*', text: '' }, { width: 240, stack: totalsRows }] },
  ];

  // Teacher-billed callout (amber) — explains the salary deduction on the challan itself.
  if (c.billedToTeacherId) {
    block.push({
      table: {
        widths: ['*'],
        body: [
          [
            {
              stack: [
                { text: '⚑ Staff Family Concession', style: 'calloutTitle' },
                {
                  text:
                    'This student is a staff member\'s child. Tuition & transport are settled from the ' +
                    'parent-teacher\'s salary each month — see the teacher\'s salary slip for the deduction. ' +
                    'Any amount the salary could not cover is shown as the balance due above.',
                  style: 'calloutBody',
                },
              ],
              fillColor: '#fffbeb',
              margin: [10, 8, 10, 8],
            },
          ],
        ],
      },
      layout: {
        hLineWidth: () => 1,
        vLineWidth: () => 1,
        hLineColor: () => '#f59e0b',
        vLineColor: () => '#f59e0b',
      },
      margin: [0, 14, 0, 0],
    });
  }

  // Footer
  block.push({
    text: 'Please pay before the due date to avoid a late fee. Keep this challan as your receipt.',
    style: 'footer',
    margin: [0, 18, 0, 0],
  });

  return { stack: block };
}

const DOC_STYLES: TDocumentDefinitions['styles'] = {
  schoolName: { fontSize: 16, bold: true, color: BRAND },
  schoolMeta: { fontSize: 8, color: MUTED, margin: [0, 1, 0, 0] },
  docTitle: { fontSize: 15, bold: true, color: INK },
  docNo: { fontSize: 9, color: MUTED, margin: [0, 2, 0, 0] },
  badge: { fontSize: 8, bold: true, margin: [6, 3, 6, 3] },
  label: { fontSize: 7, bold: true, color: MUTED, characterSpacing: 1 },
  value: { fontSize: 12, bold: true, color: INK, margin: [0, 2, 0, 0] },
  metaSm: { fontSize: 9, color: MUTED, margin: [0, 1, 0, 0] },
  th: { fontSize: 8, bold: true, color: MUTED, characterSpacing: 0.5 },
  cell: { fontSize: 10, color: INK },
  cellMuted: { fontSize: 9, color: MUTED },
  cellNum: { fontSize: 10, color: INK, alignment: 'right' },
  totLabel: { fontSize: 9, color: MUTED },
  totVal: { fontSize: 9, color: INK, alignment: 'right' },
  calloutTitle: { fontSize: 10, bold: true, color: '#b45309', margin: [0, 0, 0, 3] },
  calloutBody: { fontSize: 8.5, color: '#78350f', lineHeight: 1.3 },
  footer: { fontSize: 8, color: MUTED, italics: true, alignment: 'center' },
};

async function loadSchool(): Promise<SchoolInfo> {
  const s = await prisma.school.findFirst();
  return {
    name: s?.name ?? 'School',
    address: s?.address ?? null,
    phone: s?.phone ?? null,
    email: s?.email ?? null,
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

/** Render one challan to a PDF buffer. */
export async function renderChallanPdf(id: string): Promise<{ buffer: Buffer; challanNo: string }> {
  const [c, school] = await Promise.all([getChallan(id), loadSchool()]);
  const buffer = await render({
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 40],
    content: [challanContent(c, school)],
    styles: DOC_STYLES,
    defaultStyle: { font: 'Roboto' },
  });
  return { buffer, challanNo: c.challanNo };
}

/** Render many challans into a single PDF, one per page. */
export async function renderChallansBatchPdf(ids: string[]): Promise<Buffer> {
  const school = await loadSchool();
  const challans = await Promise.all(ids.map((id) => getChallan(id)));
  const content: Content[] = challans.map((c, i) => ({
    ...challanContent(c, school),
    ...(i < challans.length - 1 ? { pageBreak: 'after' as const } : {}),
  }));
  return render({
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 40],
    content,
    styles: DOC_STYLES,
    defaultStyle: { font: 'Roboto' },
  });
}
