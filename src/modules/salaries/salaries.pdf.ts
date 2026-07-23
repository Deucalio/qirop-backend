import PdfPrinterModule from 'pdfmake';
import type { TDocumentDefinitions, Content, TFontDictionary, TableCell } from 'pdfmake/interfaces';
import { prisma } from '../../config/prisma';
import { getSalary } from './salaries.service';
import { formatPKR } from '../../utils/money';

type PdfKitDoc = NodeJS.ReadableStream & { end(): void };
const PdfPrinter = PdfPrinterModule as unknown as {
  new (fonts: TFontDictionary): { createPdfKitDocument(doc: TDocumentDefinitions): PdfKitDoc };
};
const printer = new PdfPrinter({
  Roboto: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' },
});

const BRAND = '#4f46e5';
const INK = '#1e293b';
const MUTED = '#64748b';
const LINE = '#e2e8f0';
const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function render(doc: TDocumentDefinitions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = printer.createPdfKitDocument(doc);
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    pdf.end();
  });
}

export async function renderSalarySlipPdf(id: string): Promise<{ buffer: Buffer; filename: string }> {
  const [s, school] = await Promise.all([getSalary(id), prisma.school.findFirst()]);
  const b = s.breakdown;

  const amountRow = (label: string, value: string, opts: { strong?: boolean; color?: string } = {}): Content => ({
    columns: [
      { text: label, fontSize: 9, color: opts.color ?? MUTED, bold: opts.strong },
      { text: value, fontSize: 9, alignment: 'right', color: opts.color ?? INK, bold: opts.strong },
    ],
    margin: [0, 2, 0, 2],
  });

  const content: Content[] = [
    {
      columns: [
        [
          { text: school?.name ?? 'School', fontSize: 16, bold: true, color: BRAND },
          { text: school?.address ?? '', fontSize: 8, color: MUTED },
        ],
        [
          { text: 'SALARY SLIP', fontSize: 15, bold: true, alignment: 'right', color: INK },
          { text: `${MONTHS[s.month]} ${s.year}`, fontSize: 10, alignment: 'right', color: MUTED, margin: [0, 2, 0, 0] },
          {
            table: { body: [[{ text: s.status === 'PAID' ? 'PAID' : 'PENDING', fontSize: 8, bold: true, color: s.status === 'PAID' ? '#166534' : '#854d0e', fillColor: s.status === 'PAID' ? '#dcfce7' : '#fef9c3', margin: [6, 3, 6, 3] }]] },
            layout: 'noBorders', alignment: 'right', margin: [0, 6, 0, 0],
          },
        ],
      ],
    },
    { canvas: [{ type: 'line', x1: 0, y1: 8, x2: 515, y2: 8, lineWidth: 2, lineColor: BRAND }], margin: [0, 6, 0, 10] },

    {
      columns: [
        [
          { text: 'EMPLOYEE', fontSize: 7, bold: true, color: MUTED, characterSpacing: 1 },
          { text: s.teacherName, fontSize: 13, bold: true, color: INK, margin: [0, 2, 0, 0] },
          { text: `Employee ID: ${s.employeeId}`, fontSize: 9, color: MUTED },
        ],
        s.paidDate
          ? [{ text: 'PAID ON', fontSize: 7, bold: true, color: MUTED, alignment: 'right', characterSpacing: 1 }, { text: s.paidDate, fontSize: 11, bold: true, alignment: 'right', color: INK, margin: [0, 2, 0, 0] }]
          : [{ text: '' }],
      ],
      margin: [0, 0, 0, 14],
    },

    // Earnings / deductions
    {
      columns: [
        {
          width: '*',
          stack: [
            { text: 'EARNINGS', fontSize: 8, bold: true, color: '#166534', margin: [0, 0, 0, 4] },
            amountRow('Basic salary', formatPKR(s.basicSalary)),
            amountRow('Allowances', formatPKR(s.allowances)),
          ],
          margin: [0, 0, 12, 0],
        },
        {
          width: '*',
          stack: [
            { text: 'DEDUCTIONS', fontSize: 8, bold: true, color: '#991b1b', margin: [0, 0, 0, 4] },
            amountRow('Other deductions', formatPKR(s.deductions)),
            amountRow('Children\'s fees + transport', formatPKR(s.staffFeeDeduction), { color: '#7c3aed' }),
          ],
        },
      ],
    },

    { canvas: [{ type: 'line', x1: 0, y1: 6, x2: 515, y2: 6, lineWidth: 1, lineColor: LINE }], margin: [0, 10, 0, 8] },
    {
      columns: [
        { text: 'NET SALARY', fontSize: 12, bold: true, color: INK },
        { text: formatPKR(s.netSalary), fontSize: 14, bold: true, alignment: 'right', color: '#166534' },
      ],
    },
  ];

  // Staff-fee deduction breakdown (§7) — amber callout + child table.
  if (Number(s.staffFeeDeduction) > 0 || b.children.length > 0) {
    content.push({
      table: {
        widths: ['*'],
        body: [[{
          stack: [
            { text: '⚑ Why fees were deducted from this salary', fontSize: 10, bold: true, color: '#b45309', margin: [0, 0, 0, 3] },
            {
              text:
                'This teacher has children enrolled at the school (and/or uses school transport). Their monthly fees are ' +
                'settled from this salary instead of being collected in cash. ' +
                (Number(b.uncoveredPayable) > 0
                  ? `The salary covered Rs ${b.childrenCovered}; Rs ${b.uncoveredPayable} could not be covered and remains payable on the children's challans.`
                  : 'The salary covered all of it.'),
              fontSize: 8.5, color: '#78350f', lineHeight: 1.3,
            },
          ],
          fillColor: '#fffbeb', margin: [10, 8, 10, 8],
        }]],
      },
      layout: { hLineWidth: () => 1, vLineWidth: () => 1, hLineColor: () => '#f59e0b', vLineColor: () => '#f59e0b' },
      margin: [0, 16, 0, 10],
    });

    if (Number(b.transportCovered) > 0) {
      content.push({ text: `Own transport${b.transportRoute ? ` (${b.transportRoute})` : ''}: ${formatPKR(b.transportCovered)}`, fontSize: 9, color: MUTED, margin: [0, 0, 0, 6] });
    }

    if (b.children.length > 0) {
      content.push({
        table: {
          headerRows: 1,
          widths: ['*', 'auto', 'auto', 'auto'],
          body: [
            [
              { text: 'Child (challan)', fontSize: 8, bold: true, color: MUTED },
              { text: 'Fee', fontSize: 8, bold: true, color: MUTED, alignment: 'right' },
              { text: 'From salary', fontSize: 8, bold: true, color: MUTED, alignment: 'right' },
              { text: 'Still payable', fontSize: 8, bold: true, color: MUTED, alignment: 'right' },
            ],
            ...b.children.map((c): TableCell[] => [
              { text: `${c.studentName} (${c.challanNo})`, fontSize: 9 },
              { text: formatPKR(c.billable), fontSize: 9, alignment: 'right' },
              { text: formatPKR(c.covered), fontSize: 9, alignment: 'right', color: '#7c3aed' },
              { text: formatPKR(c.payable), fontSize: 9, alignment: 'right', color: Number(c.payable) > 0 ? '#dc2626' : '#166534' },
            ]),
          ],
        },
        layout: {
          hLineWidth: (i: number, node: { table: { body: unknown[] } }) => (i === 0 || i === 1 || i === node.table.body.length ? 1 : 0.5),
          vLineWidth: () => 0,
          hLineColor: (i: number) => (i === 1 ? '#f59e0b' : LINE),
          paddingTop: () => 5, paddingBottom: () => 5,
        },
      });
    }
  }

  content.push({ text: 'This is a computer-generated salary slip.', fontSize: 8, italics: true, color: MUTED, alignment: 'center', margin: [0, 20, 0, 0] });

  const buffer = await render({ pageSize: 'A4', pageMargins: [40, 40, 40, 40], content, defaultStyle: { font: 'Roboto' } });
  return { buffer, filename: `salary-${s.employeeId}-${s.year}-${String(s.month).padStart(2, '0')}.pdf` };
}
