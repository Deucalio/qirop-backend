-- CreateEnum
CREATE TYPE "QualificationLevel" AS ENUM ('MATRICULATION', 'INTERMEDIATE', 'BACHELOR', 'MASTERS');

-- AlterEnum
ALTER TYPE "ChallanStatus" ADD VALUE 'ADVANCE';

-- CreateTable
CREATE TABLE "TeacherQualification" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "level" "QualificationLevel" NOT NULL,
    "institution" TEXT NOT NULL,
    "passingYear" INTEGER NOT NULL,
    "marks" TEXT,
    "grade" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherQualification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeacherQualification_teacherId_idx" ON "TeacherQualification"("teacherId");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherQualification_teacherId_level_key" ON "TeacherQualification"("teacherId", "level");

-- AddForeignKey
ALTER TABLE "TeacherQualification" ADD CONSTRAINT "TeacherQualification_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "TeacherProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
