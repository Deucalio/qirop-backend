import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Next sequential staff employee ID ("EMP-101", "EMP-102", …).
 *
 * Shared by the teacher and system-user creation flows so both draw from one
 * sequence — two separate generators would eventually collide on the unique
 * `TeacherProfile.employeeId`.
 */
export async function nextEmployeeId(db: Db): Promise<string> {
  const latest = await db.teacherProfile.findFirst({
    where: { employeeId: { startsWith: 'EMP-' } },
    orderBy: { employeeId: 'desc' },
  });

  let next = 101;
  if (latest) {
    const parsed = parseInt(latest.employeeId.replace('EMP-', ''), 10);
    if (!Number.isNaN(parsed)) next = parsed + 1;
  }
  return `EMP-${next}`;
}
