import { prisma } from '../config/prisma';
import { hashPassword } from '../utils/password';

async function main() {
  const defaultPassword = 'parent1234';
  const newHash = await hashPassword(defaultPassword);
  
  const parents = await prisma.parentProfile.findMany({
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

  console.log(`Found ${parents.length} parent account(s) in database.`);

  const userIds = parents.map((p) => p.userId);

  if (userIds.length > 0) {
    const result = await prisma.user.updateMany({
      where: {
        OR: [
          { id: { in: userIds } },
          { role: 'PARENT' },
        ],
      },
      data: {
        passwordHash: newHash,
      },
    });

    console.log(`Successfully reset password to "${defaultPassword}" for ${result.count} parent user account(s).`);
  } else {
    console.log('No parent accounts found.');
  }
}

main()
  .catch((err) => {
    console.error('Error resetting parent passwords:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
