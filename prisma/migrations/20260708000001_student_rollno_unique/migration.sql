-- Enforce unique roll number within a section (NULL roll numbers are allowed).
CREATE UNIQUE INDEX "Student_sectionId_rollNo_key" ON "Student"("sectionId", "rollNo");
