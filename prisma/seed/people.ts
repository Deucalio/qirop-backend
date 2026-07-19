import { PrismaClient, Prisma, Role, Gender, UserStatus, QualificationLevel } from '@prisma/client';

/** Default password for all seeded teachers and parents. */
export const DEFAULT_PEOPLE_PASSWORD = 'Password#123';

interface QualificationDef {
  level: QualificationLevel;
  institution: string;
  passingYear: number;
  marks: string;
  grade: string;
}

interface TeacherDef {
  cnic: string;
  fullName: string;
  phone: string;
  employeeId: string;
  qualification: string;
  salary: string;
  qualifications: QualificationDef[];
}
interface ParentDef {
  cnic: string;
  fullName: string;
  phone: string;
  occupation: string;
}
interface StudentDef {
  admissionNo: string;
  rollNo: string;
  firstName: string;
  lastName: string;
  gender: Gender;
  dob: string;
  className: string;
  sectionName: string;
  parentCnic: string;
}

const TEACHERS: TeacherDef[] = [
  {
    cnic: '35201-1000001-1', fullName: 'Ayesha Khan', phone: '0300-1000001', employeeId: 'EMP-101', qualification: 'M.Sc Mathematics', salary: '65000.00',
    qualifications: [
      { level: 'MATRICULATION', institution: 'BISE Lahore', passingYear: 2008, marks: '890/1050', grade: 'A+' },
      { level: 'INTERMEDIATE', institution: 'BISE Lahore', passingYear: 2010, marks: '912/1100', grade: 'A+' },
      { level: 'BACHELOR', institution: 'University of the Punjab', passingYear: 2014, marks: '3.4/4.0 CGPA', grade: '1st Division' },
      { level: 'MASTERS', institution: 'University of the Punjab', passingYear: 2016, marks: '3.6/4.0 CGPA', grade: '1st Division' },
    ],
  },
  {
    cnic: '35201-1000002-2', fullName: 'Bilal Ahmed', phone: '0300-1000002', employeeId: 'EMP-102', qualification: 'M.A English', salary: '60000.00',
    qualifications: [
      { level: 'MATRICULATION', institution: 'BISE Gujranwala', passingYear: 2006, marks: '765/1050', grade: 'A' },
      { level: 'INTERMEDIATE', institution: 'BISE Gujranwala', passingYear: 2008, marks: '832/1100', grade: 'A' },
      { level: 'BACHELOR', institution: 'GC University Lahore', passingYear: 2012, marks: '620/800', grade: '1st Division' },
      { level: 'MASTERS', institution: 'GC University Lahore', passingYear: 2014, marks: '3.2/4.0 CGPA', grade: '1st Division' },
    ],
  },
  {
    cnic: '35201-1000003-3', fullName: 'Sana Malik', phone: '0300-1000003', employeeId: 'EMP-103', qualification: 'M.A Urdu', salary: '58000.00',
    qualifications: [
      { level: 'MATRICULATION', institution: 'BISE Rawalpindi', passingYear: 2009, marks: '812/1050', grade: 'A' },
      { level: 'INTERMEDIATE', institution: 'BISE Rawalpindi', passingYear: 2011, marks: '858/1100', grade: 'A' },
      { level: 'BACHELOR', institution: 'Fatima Jinnah Women University', passingYear: 2015, marks: '3.1/4.0 CGPA', grade: '2nd Division' },
      { level: 'MASTERS', institution: 'Allama Iqbal Open University', passingYear: 2018, marks: '3.3/4.0 CGPA', grade: '1st Division' },
    ],
  },
  {
    // Deliberately missing Masters — exercises the "not on record" state in the UI.
    cnic: '35201-1000004-4', fullName: 'Usman Tariq', phone: '0300-1000004', employeeId: 'EMP-104', qualification: 'B.Sc Computer Science', salary: '62000.00',
    qualifications: [
      { level: 'MATRICULATION', institution: 'BISE Faisalabad', passingYear: 2011, marks: '901/1050', grade: 'A+' },
      { level: 'INTERMEDIATE', institution: 'BISE Faisalabad', passingYear: 2013, marks: '876/1100', grade: 'A' },
      { level: 'BACHELOR', institution: 'COMSATS University Islamabad', passingYear: 2017, marks: '3.5/4.0 CGPA', grade: '1st Division' },
    ],
  },
];

const PARENTS: ParentDef[] = [
  { cnic: '35201-2000001-1', fullName: 'Imran Hassan', phone: '0301-2000001', occupation: 'Engineer' },
  { cnic: '35201-2000002-2', fullName: 'Fatima Noor', phone: '0301-2000002', occupation: 'Doctor' },
  { cnic: '35201-2000003-3', fullName: 'Kamran Ali', phone: '0301-2000003', occupation: 'Businessman' },
  { cnic: '35201-2000004-4', fullName: 'Nadia Sheikh', phone: '0301-2000004', occupation: 'Teacher' },
];

// Imran Hassan (parent 1) has two children (ADM-101, ADM-102) — multi-child test.
const STUDENTS: StudentDef[] = [
  { admissionNo: 'ADM-101', rollNo: '1', firstName: 'Ahmed', lastName: 'Hassan', gender: Gender.MALE, dob: '2018-03-10', className: 'Class 1', sectionName: 'A', parentCnic: '35201-2000001-1' },
  { admissionNo: 'ADM-102', rollNo: '1', firstName: 'Zara', lastName: 'Hassan', gender: Gender.FEMALE, dob: '2017-07-22', className: 'Class 2', sectionName: 'A', parentCnic: '35201-2000001-1' },
  { admissionNo: 'ADM-103', rollNo: '1', firstName: 'Ali', lastName: 'Noor', gender: Gender.MALE, dob: '2018-01-05', className: 'Class 1', sectionName: 'B', parentCnic: '35201-2000002-2' },
  { admissionNo: 'ADM-104', rollNo: '1', firstName: 'Hina', lastName: 'Ali', gender: Gender.FEMALE, dob: '2016-11-30', className: 'Class 3', sectionName: 'A', parentCnic: '35201-2000003-3' },
  { admissionNo: 'ADM-105', rollNo: '1', firstName: 'Bilal', lastName: 'Sheikh', gender: Gender.MALE, dob: '2014-05-18', className: 'Class 5', sectionName: 'A', parentCnic: '35201-2000004-4' },
  { admissionNo: 'ADM-106', rollNo: '1', firstName: 'Sara', lastName: 'Ali', gender: Gender.FEMALE, dob: '2014-09-12', className: 'Class 5', sectionName: 'B', parentCnic: '35201-2000003-3' },
  { admissionNo: 'ADM-107', rollNo: '1', firstName: 'Omar', lastName: 'Noor', gender: Gender.MALE, dob: '2015-02-25', className: 'Class 4', sectionName: 'A', parentCnic: '35201-2000002-2' },
  { admissionNo: 'ADM-108', rollNo: '2', firstName: 'Ayesha', lastName: 'Sheikh', gender: Gender.FEMALE, dob: '2014-12-01', className: 'Class 5', sectionName: 'A', parentCnic: '35201-2000004-4' },
];

async function findSectionId(prisma: PrismaClient, className: string, sectionName: string) {
  const section = await prisma.section.findFirst({
    where: { name: sectionName, class: { name: className } },
    select: { id: true },
  });
  return section?.id ?? null;
}

/** Idempotent: upsert on cnic (users), userId (profiles), admissionNo (students). */
export async function seedPeople(prisma: PrismaClient, passwordHash: string) {
  for (const t of TEACHERS) {
    const user = await prisma.user.upsert({
      where: { cnic: t.cnic },
      update: { fullName: t.fullName, phone: t.phone, role: Role.TEACHER },
      create: { cnic: t.cnic, fullName: t.fullName, phone: t.phone, passwordHash, role: Role.TEACHER },
    });
    const profile = await prisma.teacherProfile.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        employeeId: t.employeeId,
        qualification: t.qualification,
        joiningDate: new Date('2023-01-15'),
        salary: new Prisma.Decimal(t.salary),
        status: UserStatus.ACTIVE,
      },
    });
    for (const q of t.qualifications) {
      await prisma.teacherQualification.upsert({
        where: { teacherId_level: { teacherId: profile.id, level: q.level } },
        update: { institution: q.institution, passingYear: q.passingYear, marks: q.marks, grade: q.grade },
        create: { teacherId: profile.id, ...q },
      });
    }
  }

  for (const p of PARENTS) {
    const user = await prisma.user.upsert({
      where: { cnic: p.cnic },
      update: { fullName: p.fullName, phone: p.phone, role: Role.PARENT },
      create: { cnic: p.cnic, fullName: p.fullName, phone: p.phone, passwordHash, role: Role.PARENT },
    });
    await prisma.parentProfile.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id, occupation: p.occupation },
    });
  }

  for (const s of STUDENTS) {
    const sectionId = await findSectionId(prisma, s.className, s.sectionName);
    const parentUser = await prisma.user.findUnique({
      where: { cnic: s.parentCnic },
      include: { parentProfile: true },
    });
    if (!sectionId || !parentUser?.parentProfile) continue;
    await prisma.student.upsert({
      where: { admissionNo: s.admissionNo },
      update: {},
      create: {
        admissionNo: s.admissionNo,
        rollNo: s.rollNo,
        firstName: s.firstName,
        lastName: s.lastName,
        gender: s.gender,
        dob: new Date(s.dob),
        admissionDate: new Date('2024-04-01'),
        sectionId,
        parentId: parentUser.parentProfile.id,
      },
    });
  }

  return {
    teachers: TEACHERS.map((t) => ({ cnic: t.cnic, fullName: t.fullName })),
    parents: PARENTS.map((p) => ({ cnic: p.cnic, fullName: p.fullName })),
  };
}
