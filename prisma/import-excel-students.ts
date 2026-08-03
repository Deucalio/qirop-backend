import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';
import bcrypt from 'bcrypt';
import { PrismaClient, Gender, UserStatus, Role } from '@prisma/client';

const prisma = new PrismaClient();

// Class mapping to order and standard name
const CLASS_ORDER_MAP: Record<string, { name: string; order: number }> = {
  'play group': { name: 'Play Group', order: 1 },
  'playgroup': { name: 'Play Group', order: 1 },
  'pri-nursery': { name: 'Pri-Nursery', order: 2 },
  'prinursery': { name: 'Pri-Nursery', order: 2 },
  'nursery': { name: 'Nursery', order: 3 },
  'one': { name: 'Class 1', order: 4 },
  'class 1': { name: 'Class 1', order: 4 },
  'two': { name: 'Class 2', order: 5 },
  'class 2': { name: 'Class 2', order: 5 },
  'three': { name: 'Class 3', order: 6 },
  'class 3': { name: 'Class 3', order: 6 },
  'four': { name: 'Class 4', order: 7 },
  'class 4': { name: 'Class 4', order: 7 },
  'five': { name: 'Class 5', order: 8 },
  'class 5': { name: 'Class 5', order: 8 },
  'six': { name: 'Class 6', order: 9 },
  'class 6': { name: 'Class 6', order: 9 },
  'seven': { name: 'Class 7', order: 10 },
  'class 7': { name: 'Class 7', order: 10 },
  'eight': { name: 'Class 8', order: 11 },
  'class 8': { name: 'Class 8', order: 11 },
};

function parseExcelDate(val: any): Date {
  if (!val) return new Date('2015-01-01');
  if (typeof val === 'number') {
    // Excel serial number conversion
    const date = new Date((val - (25567 + 2)) * 86400 * 1000);
    return isNaN(date.getTime()) ? new Date('2015-01-01') : date;
  }
  const str = String(val).trim();
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) return parsed;

  // Custom PK format DD-MMM-YY e.g. 01-Apr-13
  const parts = str.split('-');
  if (parts.length === 3) {
    const day = parseInt(parts[0], 10);
    const months: Record<string, number> = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
    };
    const month = months[parts[1].toLowerCase().substring(0, 3)];
    let year = parseInt(parts[2], 10);
    if (year < 100) year += (year > 50 ? 1900 : 2000);
    if (!isNaN(day) && month !== undefined && !isNaN(year)) {
      return new Date(year, month, day);
    }
  }
  return new Date('2015-01-01');
}

function formatCnic(cnicRaw: string, parentIdx: number): string {
  const digits = String(cnicRaw || '').replace(/\D/g, '');
  if (digits.length === 13 && digits !== '0000000000000') {
    return `${digits.substring(0, 5)}-${digits.substring(5, 12)}-${digits.substring(12)}`;
  }
  // Generate deterministic CNIC for entries without valid CNIC
  const seq = String(parentIdx).padStart(7, '0');
  return `99999-${seq}-0`;
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const clean = fullName.trim().replace(/\s+/g, ' ');
  if (!clean) return { firstName: 'Student', lastName: 'Record' };
  const parts = clean.split(' ');
  if (parts.length === 1) return { firstName: parts[0], lastName: 'Student' };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  };
}

async function main() {
  console.log('🚀 Starting Excel Student Data Import...');

  // 1. Locate Excel file
  let filePath = process.argv[2];
  if (!filePath) {
    const candidates = [
      path.join(__dirname, '../data/All Stunds.xlsx'),
      path.join(process.cwd(), 'data/All Stunds.xlsx'),
      path.join(__dirname, '../../important-docs/All Stunds.xlsx'),
    ];
    filePath = candidates.find((p) => fs.existsSync(p)) || candidates[0];
  }

  if (!fs.existsSync(filePath)) {
    console.error(`❌ Error: File not found at ${filePath}`);
    console.log('Usage: npx tsx prisma/import-excel-students.ts [path/to/file.xlsx]');
    process.exit(1);
  }

  console.log(`📁 Reading Excel file: ${filePath}`);
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const rows: any[] = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

  console.log(`📊 Total rows found in sheet: ${rows.length}`);

  // Default password hash for parent accounts
  const defaultPasswordHash = await bcrypt.hash('Parent@123', 10);

  // 2. Ensure all Classes and Sections exist
  const sectionMap: Record<string, string> = {}; // classNameLower -> sectionId

  for (const [key, classInfo] of Object.entries(CLASS_ORDER_MAP)) {
    let cls = await prisma.class.findUnique({ where: { name: classInfo.name } });
    if (!cls) {
      cls = await prisma.class.create({
        data: {
          name: classInfo.name,
          order: classInfo.order,
        },
      });
      console.log(`  + Created Class: ${cls.name}`);
    }

    let sec = await prisma.section.findFirst({
      where: { classId: cls.id, name: 'A' },
    });
    if (!sec) {
      sec = await prisma.section.create({
        data: {
          name: 'A',
          classId: cls.id,
          isDefault: true,
        },
      });
      console.log(`  + Created Section A for ${cls.name}`);
    }
    sectionMap[key] = sec.id;
  }

  // Fallback section if class name is unrecognized
  let defaultClass = await prisma.class.findFirst({ orderBy: { order: 'asc' } });
  let defaultSection = await prisma.section.findFirst({ where: { classId: defaultClass!.id } });

  // 3. Parent Deduplication Map
  // Key: CNIC or (FatherName + Phone) -> ParentProfile ID
  const parentMap = new Map<string, string>();
  let parentCounter = 1;

  let activeCount = 0;
  let inactiveCount = 0;
  let importedStudents = 0;

  console.log('🔄 Processing student and parent records...');

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const studentName = String(row['Student Name'] || '').trim();
    if (!studentName) continue; // skip empty rows

    const fatherName = String(row["Father's Name"] || row['Guardian Name'] || 'Father').trim();
    const cnicRaw = String(row['CNICNO'] || '').trim();
    const phoneRaw = String(row['Contact'] || row['AlternateContact'] || '').trim();
    const address = String(row['Address'] || '').trim();
    const occupation = String(row['Occupation'] || '').trim();

    // Deduplication Key
    const digitsOnlyCnic = cnicRaw.replace(/\D/g, '');
    const parentKey = digitsOnlyCnic.length === 13 && digitsOnlyCnic !== '0000000000000'
      ? digitsOnlyCnic
      : `${fatherName.toLowerCase()}_${phoneRaw.replace(/\D/g, '') || parentCounter}`;

    let parentId = parentMap.get(parentKey);

    if (!parentId) {
      // Check if parent user already exists in DB
      const cnicFormatted = formatCnic(cnicRaw, parentCounter);
      let user = await prisma.user.findUnique({ where: { cnic: cnicFormatted } });

      if (!user) {
        user = await prisma.user.create({
          data: {
            cnic: cnicFormatted,
            fullName: fatherName,
            phone: phoneRaw && phoneRaw !== '00000000000' ? phoneRaw : null,
            passwordHash: defaultPasswordHash,
            role: Role.PARENT,
            status: UserStatus.ACTIVE,
          },
        });
      }

      let parentProfile = await prisma.parentProfile.findUnique({ where: { userId: user.id } });
      if (!parentProfile) {
        parentProfile = await prisma.parentProfile.create({
          data: {
            userId: user.id,
            occupation: occupation || null,
            address: address || null,
          },
        });
      }
      parentId = parentProfile.id;
      parentMap.set(parentKey, parentId);
      parentCounter++;
    }

    // 4. Map Class & Section
    const rawClassStr = String(row['Current Class'] || row['Class'] || '').trim().toLowerCase();
    const mappedClassInfo = CLASS_ORDER_MAP[rawClassStr];
    const sectionId = mappedClassInfo ? sectionMap[rawClassStr] : defaultSection!.id;

    // 5. Map Status
    const statusRaw = String(row['Status'] || '').trim().toLowerCase();
    const isStudentActive = statusRaw === 'active' || statusRaw === 'free';
    const dbStatus = isStudentActive ? UserStatus.ACTIVE : UserStatus.INACTIVE;

    if (isStudentActive) activeCount++;
    else inactiveCount++;

    // 6. Map Admission Number & Roll No
    const studentIdRaw = String(row['StudentID'] || row['StudentBarcode'] || (i + 1)).trim();
    // Option B: Prefix real Excel students with Real/EXC- format to prevent collision with demo ADM-101
    const admissionNo = `STD-${studentIdRaw}`;
    const rollNo = row['Roll No'] ? String(row['Roll No']).trim() : null;

    // Name & Demographics
    const { firstName, lastName } = splitName(studentName);
    const genderRaw = String(row['Gender'] || '').trim().toLowerCase();
    const gender = genderRaw.includes('girl') || genderRaw.includes('female') ? Gender.FEMALE : Gender.MALE;

    const dob = parseExcelDate(row['Date of Birth']);
    const admissionDate = parseExcelDate(row['Date of Admission']);
    const caste = String(row['Caste'] || '').trim() || null;
    const religion = String(row['Religion'] || 'Islam').trim() || 'Islam';
    const bFormNo = String(row['BformNo'] || row['BA'] || '').trim() || null;

    // Upsert Student
    await prisma.student.upsert({
      where: { admissionNo },
      update: {
        firstName,
        lastName,
        gender,
        dob,
        admissionDate,
        caste,
        religion,
        bFormNo,
        status: dbStatus,
        sectionId,
        parentId,
      },
      create: {
        admissionNo,
        rollNo,
        firstName,
        lastName,
        gender,
        dob,
        admissionDate,
        caste,
        religion,
        bFormNo,
        status: dbStatus,
        sectionId,
        parentId,
      },
    });

    importedStudents++;
  }

  console.log('\n✅ Import Completed Successfully!');
  console.log(`  • Total Students Imported: ${importedStudents}`);
  console.log(`  • Active Students: ${activeCount}`);
  console.log(`  • Inactive/Left/Passed Students: ${inactiveCount}`);
  console.log(`  • Unique Parent Profiles Linked: ${parentMap.size}`);
}

main()
  .catch((e) => {
    console.error('❌ Import failed with error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
