import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { getSalary } from './salaries.service';
import { formatPKR } from '../../utils/money';
import { loadSchool, render, B6_WIDTH_PT, B6_HEIGHT_PT, RECEIPT_MARGIN } from '../fees/fees.pdf';

export { B6_WIDTH_PT, B6_HEIGHT_PT };

type SalaryData = Awaited<ReturnType<typeof getSalary>>;
type SchoolData = Awaited<ReturnType<typeof loadSchool>>;

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const INK = '#000000';
const MUTED = '#4b5563';

function dmy(value: string | null): string {
  if (!value) return '-';
  const [year, month, day] = value.split('-');
  return year && month && day ? `${day}-${month}-${year}` : value;
}

function pageCount(pdf: Buffer): number {
  const counts = [...pdf.toString('latin1').matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  return counts.length ? Math.max(...counts) : 0;
}

export function buildSalarySlipBlock(s: SalaryData, school: SchoolData, scale = 1, addPageBreak = false): Content {
  const sc = (n: number) => Math.round(n * scale * 100) / 100;
  const isPaid = s.status === 'PAID';
  const period = `${MONTHS[s.month] ?? ''} ${s.year}`.trim();
  const b = s.breakdown;

  const titleText = isPaid
    ? `PAID SALARY SLIP — ${period.toUpperCase()}`
    : `SALARY SLIP — ${period.toUpperCase()}`;

  const title: Content = {
    text: titleText,
    fontSize: sc(10),
    bold: true,
    alignment: 'center',
    color: INK,
    margin: [0, sc(3.5), 0, sc(3.5)],
  };

  const schoolDetails = {
    stack: [
      { text: school.name.toUpperCase(), fontSize: sc(9), bold: true, color: INK, lineHeight: 1.1 },
      ...(school.address ? [{ text: school.address, fontSize: sc(7), color: MUTED, lineHeight: 1.1 }] : []),
      ...(school.phone ? [{ text: school.phone, fontSize: sc(7), color: MUTED, lineHeight: 1.1 }] : []),
    ],
  };

  const schoolBlock: Content = school.logoDataUri
    ? {
        columns: [
          { image: 'logo', fit: [sc(28), sc(28)], width: sc(30) },
          { ...schoolDetails, margin: [0, 1, 0, 0] },
        ],
        columnGap: sc(6),
        margin: [sc(8), sc(3.5), sc(8), sc(3.5)],
      }
    : { ...schoolDetails, margin: [sc(8), sc(3.5), sc(8), sc(3.5)] };

  const identity: Content = {
    stack: [
      {
        columns: [
          { text: [{ text: 'Employee: ', bold: true }, s.teacherName], fontSize: sc(8) },
          { text: [{ text: 'Employee ID: ', bold: true }, s.employeeId], fontSize: sc(8), alignment: 'right' },
        ],
      },
      {
        columns: [
          { text: [{ text: 'Salary Month: ', bold: true }, period], fontSize: sc(8) },
          {
            text: isPaid ? [{ text: 'Paid on: ', bold: true }, dmy(s.paidDate)] : [{ text: 'Status: ', bold: true }, 'Pending'],
            fontSize: sc(8),
            alignment: 'right',
          },
        ],
        margin: [0, sc(2), 0, 0],
      },
    ],
    margin: [sc(8), sc(3.5), sc(8), sc(3.5)],
  };

  const pRow = (
    c1: string,
    c2: string,
    c3: string,
    c4: string,
    opts: { bold?: boolean; isHeader?: boolean } = {},
  ) => {
    const size = sc(opts.isHeader ? 7.5 : 8);
    const bold = opts.bold || opts.isHeader;
    const pad = sc(2.2);
    return [
      { text: c1, fontSize: size, bold, margin: [0, pad, 0, pad] },
      { text: c2, fontSize: size, bold, alignment: 'right' as const, margin: [0, pad, 0, pad] },
      { text: c3, fontSize: size, bold, margin: [0, pad, 0, pad] },
      { text: c4, fontSize: size, bold, alignment: 'right' as const, margin: [0, pad, 0, pad] },
    ];
  };

  const grossEarnings = Number(s.basicSalary) + Number(s.allowances);
  const totalDeductions = Number(s.deductions) + Number(s.staffFeeDeduction);

  const payrollTable: Content = {
    table: {
      headerRows: 1,
      widths: ['*', sc(56), '*', sc(56)],
      body: [
        pRow('EARNINGS', 'AMOUNT', 'DEDUCTIONS', 'AMOUNT', { isHeader: true }),
        pRow('Basic salary', formatPKR(s.basicSalary), 'Other deductions', formatPKR(s.deductions)),
        pRow('Allowances', formatPKR(s.allowances), 'Children fee & trans.', formatPKR(s.staffFeeDeduction)),
        pRow('GROSS EARNINGS', formatPKR(grossEarnings), 'TOTAL DEDUCTIONS', formatPKR(totalDeductions), { bold: true }),
      ] as any,
    },
    layout: {
      hLineWidth: (i: number) => (i === 1 ? 0.5 : i === 4 ? 0.5 : 0.25),
      vLineWidth: () => 0.25,
      hLineColor: () => INK,
      vLineColor: () => INK,
      paddingLeft: () => sc(4),
      paddingRight: () => sc(4),
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
    margin: [sc(8), sc(3.5), sc(8), sc(3.5)],
  };

  const netTable: Content = {
    table: {
      widths: ['*', sc(110)],
      body: [
        [
          { text: 'NET SALARY PAYABLE', fontSize: sc(9), bold: true, color: INK, margin: [0, sc(2.5), 0, sc(2.5)] },
          { text: formatPKR(s.netSalary), fontSize: sc(10), bold: true, alignment: 'right', color: INK, margin: [0, sc(2.5), 0, sc(2.5)] },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 0.6,
      vLineWidth: () => 0.6,
      hLineColor: () => INK,
      vLineColor: () => INK,
      paddingLeft: () => sc(6),
      paddingRight: () => sc(6),
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
    margin: [sc(8), sc(3), sc(8), sc(3)],
  };

  const sections: Content[] = [
    title,
    schoolBlock,
    identity,
    payrollTable,
    netTable,
  ];

  if (s.notes) {
    sections.push({
      text: [{ text: 'Note: ', bold: true }, s.notes],
      fontSize: sc(7),
      color: MUTED,
      italics: true,
      margin: [sc(8), sc(2), sc(8), sc(2)],
    });
  }

  if (Number(s.staffFeeDeduction) > 0 || (b && (b.children?.length > 0 || b.transportRoute))) {
    const settlementRows: Content[] = [
      { text: 'STAFF FEE DEDUCTION SETTLEMENT', fontSize: sc(7.5), bold: true, color: INK, margin: [0, sc(2), 0, sc(1)] },
    ];
    if (b.transportRoute || Number(b.transportFee) > 0 || Number(b.transportCovered) > 0) {
      const remaining = Math.max(0, Number(b.transportFee) - Number(b.transportCovered));
      settlementRows.push({
        table: {
          headerRows: 1,
          widths: ['*', sc(55), sc(55), sc(55)],
          body: [
            [
              { text: 'TRANSPORT DEDUCTION', fontSize: sc(7), bold: true, margin: [0, sc(1.5), 0, sc(1.5)] },
              { text: 'FEE', fontSize: sc(7), bold: true, alignment: 'right', margin: [0, sc(1.5), 0, sc(1.5)] },
              { text: 'FROM PAY', fontSize: sc(7), bold: true, alignment: 'right', margin: [0, sc(1.5), 0, sc(1.5)] },
              { text: 'BALANCE', fontSize: sc(7), bold: true, alignment: 'right', margin: [0, sc(1.5), 0, sc(1.5)] },
            ],
            [
              { text: `Own commute (${b.transportRoute ?? 'School route'})`, fontSize: sc(7), margin: [0, sc(1), 0, sc(1)] },
              { text: formatPKR(b.transportFee), fontSize: sc(7), alignment: 'right' as const, margin: [0, sc(1), 0, sc(1)] },
              { text: formatPKR(b.transportCovered), fontSize: sc(7), alignment: 'right' as const, margin: [0, sc(1), 0, sc(1)] },
              { text: formatPKR(remaining), fontSize: sc(7), alignment: 'right' as const, margin: [0, sc(1), 0, sc(1)] },
            ],
          ] as any,
        },
        layout: {
          hLineWidth: (i: number) => (i === 1 ? 0.5 : 0.25),
          vLineWidth: () => 0.25,
          hLineColor: () => INK,
          vLineColor: () => INK,
          paddingLeft: () => sc(3),
          paddingRight: () => sc(3),
          paddingTop: () => 0,
          paddingBottom: () => 0,
        },
        margin: [0, sc(1), 0, sc(2)],
      });
    }

    if (b.children?.length > 0) {
      settlementRows.push({
        table: {
          headerRows: 1,
          widths: ['*', sc(55), sc(55), sc(55)],
          body: [
            [
              { text: 'CHILD / CHALLAN', fontSize: sc(7), bold: true, margin: [0, sc(1.5), 0, sc(1.5)] },
              { text: 'FEE', fontSize: sc(7), bold: true, alignment: 'right', margin: [0, sc(1.5), 0, sc(1.5)] },
              { text: 'FROM PAY', fontSize: sc(7), bold: true, alignment: 'right', margin: [0, sc(1.5), 0, sc(1.5)] },
              { text: 'BALANCE', fontSize: sc(7), bold: true, alignment: 'right', margin: [0, sc(1.5), 0, sc(1.5)] },
            ],
            ...b.children.map((c: any) => [
              { text: `${c.studentName} (${c.challanNo})`, fontSize: sc(7), margin: [0, sc(1), 0, sc(1)] },
              { text: formatPKR(c.billable), fontSize: sc(7), alignment: 'right' as const, margin: [0, sc(1), 0, sc(1)] },
              { text: formatPKR(c.covered), fontSize: sc(7), alignment: 'right' as const, margin: [0, sc(1), 0, sc(1)] },
              { text: formatPKR(c.payable), fontSize: sc(7), alignment: 'right' as const, margin: [0, sc(1), 0, sc(1)] },
            ]),
          ] as any,
        },
        layout: {
          hLineWidth: (i: number) => (i === 1 ? 0.5 : 0.25),
          vLineWidth: () => 0.25,
          hLineColor: () => INK,
          vLineColor: () => INK,
          paddingLeft: () => sc(3),
          paddingRight: () => sc(3),
          paddingTop: () => 0,
          paddingBottom: () => 0,
        },
        margin: [0, sc(1), 0, sc(2)],
      });
    }
    sections.push({ stack: settlementRows, margin: [sc(8), sc(2), sc(8), sc(2)] });
  }

  const signature: Content = {
    columns: [
      {
        width: '*',
        stack: [
          { text: ' ', fontSize: sc(8), margin: [0, 0, 0, sc(14)] },
          { text: '_____________________', fontSize: sc(7.5) },
          { text: 'Authorized Signature', fontSize: sc(6.5), color: MUTED, margin: [0, sc(1), 0, 0] },
        ],
      },
      {
        width: '*',
        stack: [
          { text: ' ', fontSize: sc(8), margin: [0, 0, 0, sc(14)] },
          { text: '_____________________', fontSize: sc(7.5), alignment: 'right' },
          { text: 'Employee Signature', fontSize: sc(6.5), color: MUTED, alignment: 'right', margin: [0, sc(1), 0, 0] },
        ],
      },
    ],
    columnGap: sc(10),
    margin: [sc(8), sc(4), sc(8), sc(4)],
  };
  sections.push(signature);

  return {
    ...(addPageBreak ? { pageBreak: 'before' as const } : {}),
    stack: [
      {
        table: {
          widths: ['*'],
          body: sections.map((sec) => [sec]),
        },
        layout: {
          hLineWidth: (i: number, node: any) => (i === 0 || i === node.table.body.length ? 1 : 0.5),
          vLineWidth: () => 1,
          hLineColor: () => INK,
          vLineColor: () => INK,
          paddingLeft: () => 0,
          paddingRight: () => 0,
          paddingTop: () => 0,
          paddingBottom: () => 0,
        },
      },
      {
        text: 'This is a computer-generated salary slip.',
        fontSize: sc(6.5),
        italics: true,
        color: MUTED,
        alignment: 'center',
        margin: [0, sc(3), 0, 0],
      },
    ],
  };
}

function salarySlipDocument(content: Content[], school: SchoolData): TDocumentDefinitions {
  return {
    pageSize: { width: B6_WIDTH_PT, height: B6_HEIGHT_PT },
    pageMargins: [RECEIPT_MARGIN, RECEIPT_MARGIN, RECEIPT_MARGIN, RECEIPT_MARGIN],
    content,
    ...(school.logoDataUri ? { images: { logo: school.logoDataUri } } : {}),
    defaultStyle: { font: 'Roboto', fontSize: 8 },
  };
}

export async function fittedSlipScale(s: SalaryData, school: SchoolData): Promise<number> {
  const STEP = 0.04;
  const MIN = 0.7;
  let scale = 1;
  while (scale > MIN) {
    const doc = salarySlipDocument([buildSalarySlipBlock(s, school, scale)], school);
    if (pageCount(await render(doc)) <= 1) return scale;
    scale = Math.round((scale - STEP) * 100) / 100;
  }
  return MIN;
}

/** Exported for PDF layout tests; production entry points load the actual slip and school. */
export async function renderSalarySlipDocument(s: SalaryData, school: SchoolData): Promise<Buffer> {
  const scale = await fittedSlipScale(s, school);
  return render(salarySlipDocument([buildSalarySlipBlock(s, school, scale)], school));
}

export async function renderSalarySlipPdf(id: string): Promise<{ buffer: Buffer; filename: string }> {
  const [s, school] = await Promise.all([getSalary(id), loadSchool()]);
  return {
    buffer: await renderSalarySlipDocument(s, school),
    filename: `salary-${s.employeeId}-${s.year}-${String(s.month).padStart(2, '0')}.pdf`,
  };
}

export async function renderBulkSalarySlipsPdf(ids: string[]): Promise<{ buffer: Buffer; filename: string }> {
  const [slips, school] = await Promise.all([Promise.all(ids.map((id) => getSalary(id))), loadSchool()]);
  if (slips.length === 0) throw new Error('No salary slips found.');

  const content: Content[] = [];
  for (let i = 0; i < slips.length; i++) {
    const s = slips[i];
    const scale = await fittedSlipScale(s, school);
    content.push(buildSalarySlipBlock(s, school, scale, i > 0));
  }
  return { buffer: await render(salarySlipDocument(content, school)), filename: 'salaries-bulk.pdf' };
}
