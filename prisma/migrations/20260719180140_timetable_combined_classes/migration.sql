-- AlterTable
ALTER TABLE "TimetableSlot" ADD COLUMN     "groupId" TEXT;

-- CreateIndex
CREATE INDEX "TimetableSlot_groupId_idx" ON "TimetableSlot"("groupId");
