-- CreateEnum
CREATE TYPE "MarkingType" AS ENUM ('CGPA', 'MARKS', 'TEXT');

-- AlterTable: TeacherProfile — add new columns with defaults for existing rows
ALTER TABLE "TeacherProfile"
  ADD COLUMN "gender" "Gender" NOT NULL DEFAULT 'MALE',
  ADD COLUMN "fatherName" TEXT NOT NULL DEFAULT '[NEEDS UPDATE]',
  ADD COLUMN "parentCnic" TEXT;

-- Remove the defaults so new rows must supply these values explicitly
ALTER TABLE "TeacherProfile" ALTER COLUMN "gender" DROP DEFAULT;
ALTER TABLE "TeacherProfile" ALTER COLUMN "fatherName" DROP DEFAULT;

-- AlterTable: TeacherQualification — structured grading fields
ALTER TABLE "TeacherQualification"
  ADD COLUMN "markingType" "MarkingType" NOT NULL DEFAULT 'TEXT',
  ADD COLUMN "obtainedMarks" DECIMAL(7,2),
  ADD COLUMN "totalMarks" DECIMAL(7,2);
