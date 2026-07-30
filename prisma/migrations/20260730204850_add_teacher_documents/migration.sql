-- CreateTable
CREATE TABLE "TeacherDocument" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeacherDocument_teacherId_idx" ON "TeacherDocument"("teacherId");

-- AddForeignKey
ALTER TABLE "TeacherDocument" ADD CONSTRAINT "TeacherDocument_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "TeacherProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
