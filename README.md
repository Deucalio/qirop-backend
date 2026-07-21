# Qirop School ERP — Backend

REST API and database for **Qirop School of Wisdom & Technology**, a school ERP
built for a rural Pakistani school. Node.js + TypeScript + Express + Prisma +
PostgreSQL.

Phases 0–4 are built and verified: auth & RBAC, school setup, users/roles,
classes/sections/subjects, people (teachers/parents/students), assignments,
attendance (daily + per-period), weekly timetables, and homework with file
attachments. Fees, salaries, expenses and reports are **not** built yet.

---

## Stack

Node.js · TypeScript · Express 4 · Prisma 6 · PostgreSQL · bcrypt ·
JWT (httpOnly cookie) · zod · helmet · cors · express-rate-limit · multer.

## Getting started

```bash
cd backend
cp .env.example .env        # fill DATABASE_URL, JWT_SECRET, superadmin creds
npm install
npm run prisma:generate
npm run prisma:deploy       # apply existing migrations (use prisma:migrate to author new ones)
npm run prisma:seed         # idempotent: school, superadmin, classes, people, timetable, attendance
npm run dev                 # http://localhost:4000
```

> **Windows note.** `prisma generate` fails with `EPERM … query_engine-windows.dll.node`
> if the dev server is running — it holds the engine open. Stop `npm run dev`
> first, generate, then restart.

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Dev server with watch (tsx) |
| `npm run build` / `npm start` | Compile to `dist/` and run |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run prisma:migrate` | Author a new migration (dev) |
| `npm run prisma:deploy` | Apply migrations (CI/production) |
| `npm run prisma:seed` | Run the idempotent seed |
| `npm run prisma:studio` | Open Prisma Studio |

### Environment

Validated once at boot in [`src/config/env.ts`](src/config/env.ts) — the process
exits with a readable list if anything is missing.

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | ≥ 16 chars |
| `JWT_EXPIRES_IN` | Default `7d` |
| `BCRYPT_ROUNDS` | Default `12` |
| `CLIENT_ORIGIN` | CORS origin, default `http://localhost:5173` |
| `PORT` / `NODE_ENV` | Default `4000` / `development` |
| `COOKIE_SECURE` | `auto` (Secure in prod only), `true`, or `false`. **Set `false` when serving production over plain HTTP** or the browser drops the auth cookie |
| `SUPERADMIN_CNIC` / `_PASSWORD` / `_NAME` | Seeded superadmin |
| `FILESTORE_URL` / `_TOKEN` / `_APP_ID` | External file service; the token is **server-side only** |

---

## Architecture

```
src/
├── config/       env (validated), prisma client, multer upload
├── middleware/   requireAuth, requireRole, requirePermission, validate, errorHandler
├── modules/      one folder per feature: routes → controller → service → schema
├── services/     storage.ts (FileStore wrapper — the only file I/O path)
├── utils/        apiResponse, asyncHandler, jwt, password, permissions,
│                 pktDate (Asia/Karachi), attendanceMetrics
└── app.ts        router wiring + health check
```

Each module follows the same shape:

- **`*.routes.ts`** — paths, auth/permission middleware, zod body validation
- **`*.controller.ts`** — thin; unwraps `req`, calls the service, sends JSON
- **`*.service.ts`** — all business rules and Prisma access
- **`*.schema.ts`** — zod input schemas (also the source of inferred types)

Errors are always `{ error: { message, code, details? } }`. Services throw
`AppError` / `NotFound` / `Forbidden` from `utils/apiResponse`; the central
[`errorHandler`](src/middleware/errorHandler.ts) maps everything else:

| Condition | Status | Code |
| --- | --- | --- |
| Zod failure | 422 | `VALIDATION_ERROR` (+ field details) |
| Prisma `P2002` | 409 | `UNIQUE_VIOLATION` |
| Prisma `P2003` | 409 | `FOREIGN_KEY_VIOLATION` |
| Prisma `P2025` | 404 | `NOT_FOUND` |
| **DB unreachable** (`P1000/1/2/8/17`, `P2024`, init errors) | **503** | `DB_UNAVAILABLE` |
| Multer size limit | 413 | `LIMIT_FILE_SIZE` |

> The 503 case matters here: school internet drops regularly, and a connectivity
> failure is not a client error. The message tells a non-technical user to wait
> and retry rather than showing a raw Prisma code.

---

## Authorization

- **SUPERADMIN** — implicit full access to every module and action.
- **ADMIN** — per-module `AdminPermission` rows with `canView` / `canEdit` /
  `canManage`, hierarchical (`manage ⇒ edit ⇒ view`).
- **TEACHER / PARENT** — no module permissions; access is scoped per feature
  (a teacher sees their own sections, a parent only their own children).

Middleware: `requireAuth`, `requireRole(...roles)`,
`requirePermission(module, action)`. Services that also serve non-admins use
`userHasPermission()` from `utils/permissions.ts` for the same check inline.

Permission modules: `SCHOOL_SETUP`, `USERS`, `STUDENTS`, `PARENTS`, `STAFF`,
`CLASSES`, `TIMETABLE`, `ATTENDANCE`, `HOMEWORK`, `FEES`, `EXPENSES`,
`SALARIES`, `REPORTS`.

**Guardrails** (enforced server-side, not just hidden in the UI): a non-superadmin
with `USERS.canManage` cannot create or edit a SUPERADMIN, cannot grant a
permission they do not themselves hold, and cannot edit their own permissions or
deactivate themselves. `passwordHash` is never returned; teacher `salary` is
never returned to a TEACHER-role request.

---

## Dates & timezone

The school runs in **Asia/Karachi (UTC+5)**. Every attendance date is stored as
the **canonical UTC-midnight `Date` of the PKT calendar day**, so marking at
11 pm local records the right day. All conversions go through
[`utils/pktDate.ts`](src/utils/pktDate.ts) — never construct these dates inline.

Attendance metric, used identically everywhere:
`attendanceRate = (PRESENT + LATE) / totalMarkedDays`.

---

## Domain notes worth knowing

### Sections, including classes that don't have any

A class is always backed by at least one `Section` — students, timetables and
attendance all hang off sections. A class the school doesn't split gets one
section flagged `isDefault` (named `Main`), which the UI presents as "not split
into sections" rather than inventing a letter.

- Creating a class with no section names → one `isDefault` section.
- Adding the **first** real section **converts** the default (rename +
  `isDefault: false`) so its students and timetable carry over.
- Deleting the **last** section **reverts** it to the default rather than
  leaving the class with nowhere to store anything.
- Deleting a class ignores the implicit section when checking "still has
  sections", and cascades it away.
- Section names are validated to a **single letter A–Z**, upper-cased server-side
  (the UI always renders "Section A", so free text produced "Section Section C").

### Timetables

School-wide period structure lives in `School.settings.timetable` and is
configured **per weekday** — open/closed, start time, a duration for *each*
period, and one named break at a chosen position. Defaults reflect the real
school: Mon–Thu & Sat 8:00–13:30 with a break 11:30–12:00, Friday 8:00–12:30
with a Jummah break 11:00–11:30.

- `GET /api/timetable-config` returns the computed layout (per-day schedules with
  wall-clock times); `PUT` saves it. **`dryRun: true` previews the impact** —
  how many scheduled periods a structural change would drop, and in which
  sections — so the UI can confirm before destroying anything.
- Slots that no longer fit (day closed, periods removed) are deleted; everything
  else is preserved.
- Each section has a **repeat window** (`timetableFrom` / `timetableUntil`).
  Scheduling the first period seeds one week; admins can extend it. Past the end
  date the status becomes `EXPIRED` — nothing is deleted.
- Status per section: `EMPTY` → `INCOMPLETE` → `ACTIVE`, or `EXPIRED`.

**Combined classes.** Sections taught together share a `TimetableSlot.groupId`.
Each section keeps its own row, so per-section queries are untouched. Rules:
only sections **of the same class** may combine, and they must have the *same
teacher* for the *same subject*. A combined pair is deliberately **not** treated
as a teacher clash.

**Clash handling.** `PUT /sections/:id/timetable/slot` rejects a double-booked
teacher with `TEACHER_CLASH`. Passing `force: true` resolves it instead — the
teacher's other lesson is removed (leaving that section incomplete), which the UI
warns about first. `GET …/timetable/slot-options` powers that UI: per subject it
returns the teacher, whether they clash at this exact period, their whole day's
commitments, and which sections could join as a combined class.

### Subject colours

Each subject owns one colour used across timetables, the printed PDF and the
app. `Subject.colorHex` holds an admin-picked hex; when null, a built-in hue is
derived from the subject's alphabetical rank so existing data stays stable and
distinct. Colours are **unique per subject** (a duplicate is rejected with a 409
naming the owner), keeping a timetable readable at a glance.

### Files

All file I/O goes through [`services/storage.ts`](src/services/storage.ts), which
wraps the external FileStore API. Multer uses `memoryStorage()` — nothing is
written to the school server's disk. Two access patterns:

- **Public images** (logo, photos) → unguessable path, served via
  `getPublicPreviewUrl` (always `&app=` scoped).
- **Private files** (homework attachments) → never a raw FileStore URL; the API
  exposes an authenticated endpoint that checks permission then proxies the
  download. The FileStore token never reaches the browser.

---

## API reference

All routes are prefixed `/api`. Everything except `/health` and `/auth/login`
requires the auth cookie.

### Health & auth
| Method | Route | Notes |
| --- | --- | --- |
| GET | `/health` | DB connectivity check |
| POST | `/auth/login` | `{ cnic, password }` → httpOnly cookie; rate-limited |
| POST | `/auth/logout` | Clears the cookie |
| GET | `/auth/me` | Current user + permissions |
| POST | `/auth/change-password` | `{ currentPassword, newPassword }` |

### School — module `SCHOOL_SETUP`
`GET|PUT /school` · `POST /school/logo` · `GET|PUT /school/settings`
(settings are **merged**, so sub-configs like `timetable` survive a save).

### Users & roles — module `USERS`
`GET /admins` · `GET /admins/:id` · `POST /admins` · `PUT /admins/:id` ·
`PUT /admins/:id/permissions` · `POST /admins/:id/reset-password` ·
`PATCH /admins/:id/status`

### Classes, sections, subjects — module `CLASSES`
| Method | Route | Notes |
| --- | --- | --- |
| GET | `/classes` | + section/subject/student counts, rolled-up timetable status, class teachers |
| POST | `/classes` | `{ name, sections?: string[] }` — omit `sections` for an unsplit class |
| PUT | `/classes/:id` | Rename (display order is derived from the number in the name) |
| DELETE | `/classes/:id` | Blocked if it has named sections or students |
| GET/POST | `/classes/:classId/sections` | Single-letter names |
| PUT/DELETE | `/sections/:id` | Rename / remove (see section rules above) |
| GET/POST | `/subjects` | Global subject list, with resolved colours |
| PUT | `/subjects/:id` | `{ name?, color? }` — `color: null` reverts to automatic |
| DELETE | `/subjects/:id` | Blocked while mapped to any class |
| GET | `/subjects/:id/details` | Classes offering it + who teaches it (staff data gated on `STAFF` view) |
| GET/PUT | `/classes/:classId/subjects` | Class ↔ subject mapping; removing a subject also clears its teaching assignments |

### Assignments — module `STAFF`
`PUT /sections/:id/class-teacher` · `GET /sections/:sectionId/teaching-assignments` ·
`PUT /teaching-assignments` · `DELETE /teaching-assignments` ·
`GET /teachers/:id/assignments`

### Timetable — module `TIMETABLE`
| Method | Route | Notes |
| --- | --- | --- |
| GET | `/timetable-config` | Computed per-day layout (any authenticated user) |
| PUT | `/timetable-config` | `{ config, dryRun? }` — preview or apply |
| GET | `/sections/:id/timetable` | Grid + validity + combined-class partners |
| GET | `/sections/:id/timetable/slot-options` | Availability for one cell |
| PUT | `/sections/:id/timetable/slot` | `{ day, periodIndex, subjectId, withSectionIds?, force? }` |
| PUT | `/sections/:id/timetable/validity` | `{ from, until }` — `until: null` = no end date |
| GET | `/me/teacher/timetable` | Teacher's own week (role TEACHER) |
| GET | `/me/children/:studentId/timetable` | Parent view (role PARENT) |

### People
- **Teachers** (`STAFF`): `GET|POST /teachers`, `GET|PUT /teachers/:id`,
  `PATCH /teachers/:id/status` (lists held assignments; `force` to proceed),
  `POST /teachers/:id/reset-password`, `POST /teachers/:id/photo`,
  `GET /me/teacher` (**never includes salary**)
- **Parents** (`PARENTS`): `GET|POST /parents`, `GET|PUT /parents/:id`,
  `PATCH /parents/:id/status`, `POST /parents/:id/reset-password`
- **Students** (`STUDENTS`): `GET /students?classId=&sectionId=&status=&search=`,
  `GET|PUT /students/:id` (incl. section transfer), `POST /students`
  (with optional inline parent creation), `PATCH /students/:id/status`,
  `POST /students/:id/photo`, `GET /students/:id/attendance`

> Roll numbers are unique **within a section**, so a transfer usually needs a new
> one — send `rollNo` alongside `sectionId`.

### Attendance — module `ATTENDANCE`
`POST /me/teacher/attendance/check-in` · `GET /me/teacher/attendance` ·
`POST /teachers/:id/attendance` · `GET /teacher-attendance?date=` ·
`GET|POST /sections/:sectionId/attendance` (class teacher or admin) ·
`GET /attendance?date=&classId=&sectionId=` · `GET /attendance/summary` ·
`GET /attendance/trend?days=7` · `GET /me/children` ·
`GET /me/children/:studentId/attendance` ·
`GET|POST /sections/:sectionId/period-attendance` (per-period, against the timetable)

### Homework — module `HOMEWORK`
`GET /homework?classId=&sectionId=&subjectId=&from=&to=` (admin) ·
`GET /me/teacher/homework` · `POST /homework` (multipart) · `PUT /homework/:id` ·
`DELETE /homework/:id` · `GET /homework/:id` ·
`GET /homework/:id/attachment` (authenticated proxy) ·
`GET /me/children/:studentId/homework`

Teachers may only post for a `(section, subject)` pair they actually teach.

---

## Data model

25 models. The ones that carry most of the logic:

- **User** — one row per login (SUPERADMIN/ADMIN/TEACHER/PARENT), unique `cnic`.
  `AdminPermission` holds the per-module matrix.
- **Class → Section → Student** — the academic spine. `Section.isDefault` marks
  the implicit section; `Section.timetableFrom/Until` is the repeat window.
- **Subject**, **ClassSubject** (which class offers what), **TeachingAssignment**
  (`@@unique([sectionId, subjectId])` — one teacher per subject per section).
- **TimetableSlot** — `@@unique([sectionId, day, periodIndex])`, optional
  `groupId` for combined classes.
- **StudentAttendance** / **TeacherAttendance** / **TeacherPeriodAttendance** —
  all keyed on the canonical PKT day; per-period rows denormalize section and
  subject so history survives timetable edits.
- **Homework** — section + subject + teacher, optional FileStore attachment.
- Fees/salary/expense models exist in the schema but have **no API yet** (Phase 5).

Money columns are `Decimal(10,2)`, never floats.

### Migrations

| Migration | What it added |
| --- | --- |
| `init` | Full initial schema (22 models, 9 enums) |
| `student_rollno_unique` | `@@unique([sectionId, rollNo])` |
| `attendance_markedby_user` | Attendance records point at the acting user |
| `teacher_qualifications` | `TeacherQualification` ladder |
| `timetable_and_period_attendance` | `TimetableSlot`, `TeacherPeriodAttendance`, `DayOfWeek` |
| `section_timetable_validity` | `Section.timetableFrom/Until` |
| `timetable_combined_classes` | `TimetableSlot.groupId` |
| `subject_color` → `subject_color_hex` | Subject colour (index, then hex) |
| `section_is_default` | `Section.isDefault` |

### Seed

`prisma/seed.ts` orchestrates idempotent modules in dependency order —
`academics → people → assignments → timetable → attendance → homework`. Safe to
re-run; upserts on natural keys (cnic, admissionNo, employeeId). Seeded teacher
and parent CNICs plus default passwords are printed to the console afterwards.

---

## Conventions for new work

1. Route → controller → service → schema; keep business rules in the service.
2. Validate every body with zod via `validateBody`; never trust the client.
3. Throw `AppError(message, status, code)` with a message a **non-technical
   school administrator** can act on.
4. Any date that represents a school day goes through `utils/pktDate.ts`.
5. Never return `passwordHash`; never return teacher `salary` to a TEACHER.
  All file I/O through `services/storage.ts`.
7. Guard destructive operations, and prefer a **dry-run preview** where a change
   can silently destroy data (see `saveTimetableConfig`).

### Dual-Role Switcher & Student Parent linkage updates (Phase 2 additions)

- **Dual-role Switcher (`POST /auth/switch-role`)**:
  - Signs and updates a new JWT token in the secure `httpOnly` cookie containing the switched `role` (must be `TEACHER` or `PARENT`).
  - Updates the active role field inside the `User` table to match.
  - Validates that the user holds the target profile (`teacherProfile` or `parentProfile`) before switching, returning `403 Forbidden` if missing.
- **Parent Profile Auto-resolution on existing user**:
  - Inside `createStudent` and `updateStudent` services:
    - If a user with the parent's CNIC already exists in the database, the backend does not throw `CNIC_TAKEN`.
    - If the user has a `parentProfile`, it automatically links the student.
    - If the user exists (e.g. a teacher) but lacks a `parentProfile`, the backend automatically creates a `ParentProfile` linked to that user, then attaches the student.
    - Furthermore, `updateStudent` accepts `parentId` as either a `ParentProfile.id` or a `User.id` (such as a teacher's user ID) and resolves it to a parent profile seamlessly.
- **Class-wise student attendance analytics in `getTeacherAttendance`**:
  - The `GET /teachers/:id/attendance` endpoint has been enhanced to return a list of sections taught by the teacher (where they are either a Class Teacher or subject teacher).
  - For each section, it calculates the monthly overall student attendance rate (average percentage present/late) and today's mark status, allowing the admin dashboard to show teacher class-marking history.
- **Teacher Student-linking endpoint (`POST /teachers/:id/students`)**:
  - Allows linking a student directly to a teacher's parent profile. Resolves and creates a `ParentProfile` linked to the teacher's user record if not already present.
- **Student Audit Logs (`GET /students/:id/audit-logs`)**:
  - Exposes the chronological sequence of student mutation logs.
  - Automatically records student creation (`ENROLLED`), class updates (`PROMOTED` or `TRANSFERRED`), details modifications (`UPDATED`), deactivations and activations (`STATUS_CHANGE`) in the `AuditLog` table.
  - Includes changed-by user (admin name and role) information.
