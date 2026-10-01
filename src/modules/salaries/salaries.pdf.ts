import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { getSalary } from './salaries.service';
import { formatPKR } from '../../utils/money';
import { loadSchool, render } from '../fees/fees.pdf';

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

function textCell(text: string, opts: { bold?: boolean; right?: boolean; size?: number } = {}) {
  return {
    text,
    fontSize: opts.size ?? 8.5,
    bold: opts.bold ?? false,
    color: INK,
    ...(opts.right ? { alignment: 'right' as const } : {}),
    margin: [0, 3, 0, 3] as [number, number, number, number],
  };
}

const tableLayout = {
  hLineWidth: (i: number) => (i === 0 || i === 1 ? 0.7 : 0.25),
  vLineWidth: () => 0.25,
  hLineColor: () => INK,
  vLineColor: () => INK,
  paddingLeft: () => 5,
  paddingRight: () => 5,
  paddingTop: () => 1,
  paddingBottom: () => 1,
};

function schoolHeader(school: SchoolData): Content {
  const details = {
    stack: [
      { text: school.name.toUpperCase(), fontSize: 13, bold: true, color: INK },
      ...(school.address ? [{ text: school.address, fontSize: 8, color: MUTED, margin: [0, 1, 0, 0] }] : []),
      ...(school.phone ? [{ text: school.phone, fontSize: 8, color: MUTED }] : []),
    ],
  };

  return (school.logoDataUri
    ? {
        columns: [
          { image: 'logo', fit: [34, 34], width: 36 },
          { ...details, margin: [7, 1, 0, 0] },
        ],
        margin: [8, 7, 8, 7],
      }
    : { ...details, margin: [8, 7, 8, 7] }) as Content;
}

function salarySlipContent(s: SalaryData, school: SchoolData, addPageBreak = false): Content[] {
  const b = s.breakdown;
  const period = `${MONTHS[s.month] ?? ''} ${s.year}`.trim();
  const isPaid = s.status === 'PAID';
  const content: Content[] = [];

  if (addPageBreak) content.push({ text: '', pageBreak: 'before' });

  const identity = {
    table: {
      widths: ['*', '*'],
      body: [
        [
          textCell(`Employee: ${s.teacherName}`, { bold: true }),
          textCell(`Employee ID: ${s.employeeId}`, { bold: true, right: true }),
        ],
        [
          textCell(`Salary month: ${period}`),
          textCell(isPaid ? `Paid on: ${dmy(s.paidDate)}` : 'Status: Pending', { right: true }),
        ],
      ],
    },
    layout: tableLayout,
    margin: [8, 0, 8, 0],
  };

  const payroll = {
    table: {
      headerRows: 1,
      widths: ['*', 86, '*', 86],
      body: [
        [
          textCell('EARNINGS', { bold: true, size: 8 }),
          textCell('AMOUNT', { bold: true, right: true, size: 8 }),
          textCell('DEDUCTIONS', { bold: true, size: 8 }),
          textCell('AMOUNT', { bold: true, right: true, size: 8 }),
        ],
        [
          textCell('Basic salary'),
          textCell(formatPKR(s.basicSalary), { right: true }),
          textCell('Other deductions'),
          textCell(formatPKR(s.deductions), { right: true }),
        ],
        [
          textCell('Allowances'),
          textCell(formatPKR(s.allowances), { right: true }),
          textCell("Children's fees and transport"),
          textCell(formatPKR(s.staffFeeDeduction), { right: true }),
        ],
        [
          textCell('GROSS EARNINGS', { bold: true }),
          textCell(formatPKR(Number(s.basicSalary) + Number(s.allowances)), { bold: true, right: true }),
          textCell('TOTAL DEDUCTIONS', { bold: true }),
          textCell(formatPKR(Number(s.deductions) + Number(s.staffFeeDeduction)), { bold: true, right: true }),
        ],
      ],
    },
    layout: tableLayout,
    margin: [8, 9, 8, 0],
  };

  const net = {
    table: {
      widths: ['*', 140],
      body: [[textCell('NET SALARY PAYABLE', { bold: true, size: 11 }), textCell(formatPKR(s.netSalary), { bold: true, right: true, size: 11 })]],
    },
    layout: {
      hLineWidth: () => 0.9,
      vLineWidth: () => 0.9,
      hLineColor: () => INK,
      vLineColor: () => INK,
      paddingLeft: () => 6,
      paddingRight: () => 6,
      paddingTop: () => 4,
      paddingBottom: () => 4,
    },
    margin: [8, 8, 8, 8],
  };

  content.push({
    table: {
      widths: ['*'],
      body: [
        [schoolHeader(school)],
        [{ text: `${isPaid ? 'PAID ' : ''}SALARY SLIP - ${period.toUpperCase()}`, fontSize: 12, bold: true, alignment: 'center', color: INK, margin: [0, 6, 0, 6] }],
        [identity],
        [payroll],
        [net],
      ],
    },
    layout: {
      hLineWidth: () => 0.9,
      vLineWidth: () => 0.9,
      hLineColor: () => INK,
      vLineColor: () => INK,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
  } as Content);

  if (Number(s.staffFeeDeduction) > 0 || b.children.length > 0 || b.transportRoute) {
    content.push({ text: 'STAFF FEE SETTLEMENT', fontSize: 9, bold: true, color: INK, margin: [8, 14, 8, 4] });
    content.push({
      text: Number(b.uncoveredPayable) > 0
        ? `Salary covered ${formatPKR(b.childrenCovered)} of linked child fees. ${formatPKR(b.uncoveredPayable)} remains payable on the relevant challans.`
        : 'Linked child fees shown below were settled from this salary. Transport is included only for historical slips that deducted it from pay.',
      fontSize: 8,
      color: MUTED,
      margin: [8, 0, 8, 6],
    });

    if (b.transportRoute || Number(b.transportFee) > 0 || Number(b.transportCovered) > 0) {
      const remaining = Math.max(0, Number(b.transportFee) - Number(b.transportCovered));
      content.push({
        table: {
          headerRows: 1,
          widths: ['*', 80, 90, 70],
          body: [
            [
              textCell('TRANSPORT DEDUCTION', { bold: true, size: 8 }),
              textCell('FEE', { bold: true, right: true, size: 8 }),
              textCell('FROM SALARY', { bold: true, right: true, size: 8 }),
              textCell('BALANCE', { bold: true, right: true, size: 8 }),
            ],
            [
              textCell(`Own commute (${b.transportRoute ?? 'School transport route'})`),
              textCell(formatPKR(b.transportFee), { right: true }),
              textCell(formatPKR(b.transportCovered), { right: true }),
              textCell(formatPKR(remaining), { right: true }),
            ],
          ],
        },
        layout: tableLayout,
        margin: [8, 0, 8, 8],
      } as Content);
    }

    if (b.children.length > 0) {
      content.push({
        table: {
          headerRows: 1,
          widths: ['*', 72, 90, 76],
          body: [
            [
              textCell('CHILD AND CHALLAN', { bold: true, size: 8 }),
              textCell('FEE', { bold: true, right: true, size: 8 }),
              textCell('FROM SALARY', { bold: true, right: true, size: 8 }),
              textCell('STILL PAYABLE', { bold: true, right: true, size: 8 }),
            ],
            ...b.children.map((child) => [
              textCell(`${child.studentName} - ${MONTHS[child.period.month]} ${child.period.year} (${child.challanNo})`),
              textCell(formatPKR(child.billable), { right: true }),
              textCell(formatPKR(child.covered), { right: true }),
              textCell(formatPKR(child.payable), { right: true }),
            ]),
          ],
        },
        layout: tableLayout,
        margin: [8, 0, 8, 0],
      } as Content);
    }
  }

  content.push({
    columns: [
      {
        width: '*',
        stack: [
          { text: ' ', margin: [0, 18, 0, 0] },
          { text: '____________________________', fontSize: 8 },
          { text: 'Authorized Signature', fontSize: 7, color: MUTED, margin: [0, 2, 0, 0] },
        ],
      },
      {
        width: '*',
        stack: [
          { text: ' ', margin: [0, 18, 0, 0] },
          { text: '____________________________', fontSize: 8, alignment: 'right' },
          { text: 'Employee Signature', fontSize: 7, color: MUTED, alignment: 'right', margin: [0, 2, 0, 0] },
        ],
      },
    ],
    margin: [8, 22, 8, 0],
  });
  content.push({ text: 'This is a computer-generated salary slip.', fontSize: 7, italics: true, color: MUTED, alignment: 'center', margin: [0, 14, 0, 0] });
  return content;
}

function salarySlipDocument(content: Content[], school: SchoolData): TDocumentDefinitions {
  return {
    pageSize: 'A4',
    pageMargins: [32, 32, 32, 32],
    content,
    ...(school.logoDataUri ? { images: { logo: school.logoDataUri } } : {}),
    defaultStyle: { font: 'Roboto', fontSize: 8 },
  };
}

/** Exported for PDF layout tests; production entry points load the actual slip and school. */
export async function renderSalarySlipDocument(s: SalaryData, school: SchoolData): Promise<Buffer> {
  return render(salarySlipDocument(salarySlipContent(s, school), school));
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
  slips.forEach((slip, index) => content.push(...salarySlipContent(slip, school, index > 0)));
  return { buffer: await render(salarySlipDocument(content, school)), filename: 'salaries-bulk.pdf' };
}
