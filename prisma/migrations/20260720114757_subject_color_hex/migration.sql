/*
  Warnings:

  - You are about to drop the column `colorIndex` on the `Subject` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Subject" DROP COLUMN "colorIndex",
ADD COLUMN     "colorHex" TEXT;
