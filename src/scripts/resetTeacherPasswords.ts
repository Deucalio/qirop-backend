import { prisma } from '../config/prisma';
import { hashPassword } from '../utils/password';

async function main() {
  const defaultPassword = 'teacher1234';
  const newHash = await hashPassword(defaultPassword);
  
  const teachers = await prisma.teacherProfile.findMany({
    select: {
      userId: true,
      user: {
        select: {
          fullName: true,
          cnic: true,
        },
      },
    },
  });

  console.log(`Found ${teachers.length} teacher profile(s) in database.`);

  const userIds = teachers.map((t) => t.userId);

  if (userIds.length > 0) {
    const result = await prisma.user.updateMany({
      where: {
        OR: [
          { id: { in: userIds } },
          { role: 'TEACHER' },
        ],
      },
      data: {
        passwordHash: newHash,
      },
    });

    console.log(`Successfully reset password to "${defaultPassword}" for ${result.count} teacher user account(s).`);
  } else {
    console.log('No teacher accounts found.');
  }
}

main()
  .catch((err) => {
    console.error('Error resetting teacher passwords:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
