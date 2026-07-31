-- CreateTable
CREATE TABLE "SavedReport" (
    "id" TEXT NOT NULL,
    "reportType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "periodType" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER,
    "classId" TEXT,
    "sectionId" TEXT,
    "data" JSONB NOT NULL,
    "generatedBy" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SavedReport_reportType_idx" ON "SavedReport"("reportType");

-- CreateIndex
CREATE UNIQUE INDEX "SavedReport_reportType_periodType_year_month_classId_sectio_key" ON "SavedReport"("reportType", "periodType", "year", "month", "classId", "sectionId");
