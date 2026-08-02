import 'dotenv/config';
import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const cnic = process.env.SUPERADMIN_CNIC || '41205-5629827-7';
  const rawPassword = process.env.SUPERADMIN_PASSWORD || 'E8t6&xV\'"8n^8DY';
  const name = process.env.SUPERADMIN_NAME || 'School Owner';
  const rounds = Number(process.env.BCRYPT_ROUNDS || 12);

  console.log(`Setting Superadmin CNIC: "${cnic}"...`);
  const passwordHash = await bcrypt.hash(rawPassword, rounds);

  const existingSuperadmin = await prisma.user.findFirst({ where: { role: Role.SUPERADMIN } });

  if (existingSuperadmin) {
    const updated = await prisma.user.update({
      where: { id: existingSuperadmin.id },
      data: {
        cnic,
        fullName: name,
        passwordHash,
      },
    });
    console.log(`✅ Superadmin updated! ID: ${updated.id}, CNIC: ${updated.cnic}`);
  } else {
    const created = await prisma.user.upsert({
      where: { cnic },
      update: { fullName: name, role: Role.SUPERADMIN, passwordHash },
      create: { cnic, passwordHash, role: Role.SUPERADMIN, fullName: name },
    });
    console.log(`✅ Superadmin created! ID: ${created.id}, CNIC: ${created.cnic}`);
  }
}

main()
  .catch((e) => {
    console.error('❌ Error resetting superadmin:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
