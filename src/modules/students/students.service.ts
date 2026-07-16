import { Prisma, Role, UserStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { hashPassword } from '../../utils/password';
import { publicUrl, replaceFile } from '../../services/storage';
import { AppError, NotFound } from '../../utils/apiResponse';
import type { CreateStudentInput, ListStudentsQuery, UpdateStudentInput } from './students.schema';

const studentInclude = {
  section: { include: { class: true } },
  parent: { include: { user: true } },
} satisfies Prisma.StudentInclude;

type StudentWithRels = Prisma.StudentGetPayload<{ include: typeof studentInclude }>;

function shapeListItem(s: StudentWithRels) {
  return {
    id: s.id,
    admissionNo: s.admissionNo,
    rollNo: s.rollNo,
    firstName: s.firstName,
    lastName: s.lastName,
    name: `${s.firstName} ${s.lastName}`,
    gender: s.gender,
    status: s.status,
    photoUrl: publicUrl(s.photoUrl),
    section: { id: s.section.id, name: s.section.name },
    class: { id: s.section.class.id, name: s.section.class.name },
    parent: { id: s.parent.id, name: s.parent.user.fullName, phone: s.parent.user.phone },
  };
}

function shapeDetail(s: StudentWithRels) {
  return {
    ...shapeListItem(s),
    dob: s.dob,
    admissionDate: s.admissionDate,
    parent: {
      id: s.parent.id,
      name: s.parent.user.fullName,
      cnic: s.parent.user.cnic,
      phone: s.parent.user.phone,
    },
    // Populated in later phases:
    attendance: [] as unknown[],
    fees: [] as unknown[],
  };
}

async function loadStudentOr404(id: string): Promise<StudentWithRels> {
  const student = await prisma.student.findUnique({ where: { id }, include: studentInclude });
  if (!student) throw NotFound('Student not found');
  return student;
}

async function assertAdmissionFree(admissionNo: string, exceptId?: string) {
  const existing = await prisma.student.findUnique({ where: { admissionNo } });
  if (existing && existing.id !== exceptId) {
    throw new AppError('A student with this admission number already exists', 409, 'ADMISSION_NO_TAKEN');
  }
}

async function assertRollNoFree(sectionId: string, rollNo: string, exceptId?: string) {
  const existing = await prisma.student.findFirst({ where: { sectionId, rollNo } });
  if (existing && existing.id !== exceptId) {
    throw new AppError('This roll number is already used in the target section', 409, 'ROLL_NO_TAKEN');
  }
}

export async function listStudents(query: ListStudentsQuery) {
  const students = await prisma.student.findMany({
    where: {
      status: query.status,
      sectionId: query.sectionId,
      ...(query.classId ? { section: { classId: query.classId } } : {}),
      ...(query.search
        ? {
            OR: [
              { firstName: { contains: query.search, mode: 'insensitive' } },
              { lastName: { contains: query.search, mode: 'insensitive' } },
              { admissionNo: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    include: studentInclude,
    orderBy: [{ section: { class: { order: 'asc' } } }, { firstName: 'asc' }],
  });
  return students.map(shapeListItem);
}

export async function getStudent(id: string) {
  return shapeDetail(await loadStudentOr404(id));
}

export async function createStudent(actorId: string, input: CreateStudentInput) {
  const section = await prisma.section.findUnique({ where: { id: input.sectionId } });
  if (!section) throw NotFound('Section not found');

  await assertAdmissionFree(input.admissionNo);
  if (input.rollNo) await assertRollNoFree(input.sectionId, input.rollNo);

  const baseData = {
    admissionNo: input.admissionNo,
    rollNo: input.rollNo ?? null,
    firstName: input.firstName,
    lastName: input.lastName,
    gender: input.gender,
    dob: input.dob ?? null,
    admissionDate: input.admissionDate,
    sectionId: input.sectionId,
  };

  // Case 1: link to an existing parent.
  if (input.parentId) {
    const parent = await prisma.parentProfile.findUnique({ where: { id: input.parentId } });
    if (!parent) throw NotFound('Parent not found');
    const created = await prisma.student.create({ data: { ...baseData, parentId: input.parentId } });
    return getStudent(created.id);
  }

  // Case 2: create the parent + student atomically.
  const p = input.parent!;
  const cnicTaken = await prisma.user.findUnique({ where: { cnic: p.cnic } });
  if (cnicTaken) throw new AppError('A user with this CNIC already exists', 409, 'CNIC_TAKEN');
  const passwordHash = await hashPassword(p.password);

  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        cnic: p.cnic,
        fullName: p.fullName,
        phone: p.phone ?? null,
        passwordHash,
        role: Role.PARENT,
        createdById: actorId,
        parentProfile: { create: { occupation: p.occupation ?? null, address: p.address ?? null } },
      },
      include: { parentProfile: true },
    });
    return tx.student.create({ data: { ...baseData, parentId: user.parentProfile!.id } });
  });
  return getStudent(created.id);
}

export async function updateStudent(id: string, data: UpdateStudentInput) {
  const student = await prisma.student.findUnique({ where: { id } });
  if (!student) throw NotFound('Student not found');

  const targetSectionId = data.sectionId ?? student.sectionId;
  if (data.sectionId && data.sectionId !== student.sectionId) {
    const section = await prisma.section.findUnique({ where: { id: data.sectionId } });
    if (!section) throw NotFound('Target section not found');
  }
  if (data.admissionNo && data.admissionNo !== student.admissionNo) {
    await assertAdmissionFree(data.admissionNo, id);
  }
  if (data.parentId && data.parentId !== student.parentId) {
    const parent = await prisma.parentProfile.findUnique({ where: { id: data.parentId } });
    if (!parent) throw NotFound('Parent not found');
  }
  // roll number must stay unique within its (possibly new) section
  const nextRollNo = data.rollNo === undefined ? student.rollNo : data.rollNo;
  if (nextRollNo && (data.rollNo !== undefined || data.sectionId)) {
    await assertRollNoFree(targetSectionId, nextRollNo, id);
  }

  await prisma.student.update({
    where: { id },
    data: {
      admissionNo: data.admissionNo ?? undefined,
      rollNo: data.rollNo === undefined ? undefined : data.rollNo,
      firstName: data.firstName ?? undefined,
      lastName: data.lastName ?? undefined,
      gender: data.gender ?? undefined,
      dob: data.dob === undefined ? undefined : data.dob,
      admissionDate: data.admissionDate ?? undefined,
      sectionId: data.sectionId ?? undefined,
      parentId: data.parentId ?? undefined,
    },
  });
  return getStudent(id);
}

export async function setStatus(id: string, status: UserStatus) {
  const student = await prisma.student.findUnique({ where: { id } });
  if (!student) throw NotFound('Student not found');
  await prisma.student.update({ where: { id }, data: { status } });
  return getStudent(id);
}

export async function setPhoto(id: string, buffer: Buffer, originalName: string, contentType: string) {
  const student = await prisma.student.findUnique({ where: { id } });
  if (!student) throw NotFound('Student not found');
  const newPath = await replaceFile(student.photoUrl, buffer, originalName, `/students/${id}`, contentType);
  await prisma.student.update({ where: { id }, data: { photoUrl: newPath } });
  return getStudent(id);
}
