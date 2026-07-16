-- Repoint StudentAttendance.markedById from TeacherProfile to User
-- (teachers and admins both mark attendance; both are Users).
ALTER TABLE "StudentAttendance" DROP CONSTRAINT "StudentAttendance_markedById_fkey";

ALTER TABLE "StudentAttendance" ADD CONSTRAINT "StudentAttendance_markedById_fkey"
  FOREIGN KEY ("markedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
