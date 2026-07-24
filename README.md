# Qirop School ERP — Backend

REST API and database for **Qirop School of Wisdom & Technology**, a school ERP
built for a rural Pakistani school. Node.js + TypeScript + Express + Prisma +
PostgreSQL.

Phases 0–4 are built and verified: auth & RBAC, school setup, users/roles,
classes/sections/subjects, people (teachers/parents/students), assignments,
attendance (daily + per-period), weekly timetables, and homework with file
attachments. **Phase 5 is complete** — [Fees](#fees--module-fees) (challans, FIFO
payment ledger, discounts, PDFs, parent view), [Transport](#transport--module-fees)
(routes + riders, billed onto challans/salaries), and
[Salaries & Expenses](#salaries--module-salaries) (payroll with automatic staff-fee
recovery, expenses with funding sources, finance summary). Reports are **not**
built yet.

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
  `GET /me/teacher` (**never includes salary**).
  `POST /teachers` now accepts **multipart form data** with an optional `photo`
  field alongside JSON body fields (qualifications are JSON-stringified). Each
  teacher requires `gender` (`MALE`/`FEMALE`), `fatherName` (parent/guardian
  name), and optionally `parentCnic`. Education qualifications support structured
  grading via `markingType` (`CGPA`/`MARKS`/`TEXT`), `obtainedMarks`, and
  `totalMarks`.
  `DELETE /teachers/:id` — **hard purge, ADMIN/SUPERADMIN only** (`requireRole`,
  not a STAFF permission). Removes the teacher's login and everything they own
  (assignments, homework, own attendance, salary slips, qualifications).
  Records that reference them only as an *actor* (attendance they marked,
  payments they received) are **re-attributed to the deleting admin**; optional
  links back to them (`Section.classTeacherId`, `Student.teacherParentId`,
  `FeeChallan.billedToTeacherId`) are set null. Runs in one transaction.
- **Parents** (`PARENTS`): `GET|POST /parents`, `GET|PUT /parents/:id`,
  `PATCH /parents/:id/status`, `POST /parents/:id/reset-password`
- **Students** (`STUDENTS`): `GET /students?classId=&sectionId=&status=&search=`,
  `GET|PUT /students/:id` (incl. section transfer), `POST /students`
  (with optional inline parent creation), `PATCH /students/:id/status`,
  `POST /students/:id/photo`, `GET /students/:id/attendance`.
  `DELETE /students/:id` — **hard purge, ADMIN/SUPERADMIN only**. Removes the
  student plus their attendance, fee challans (+ items + allocations) and
  payments (all `onDelete: Cascade`, deleted explicitly in one transaction). The
  guardian's `ParentProfile` is kept — they may have other children.

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

### Fees — module `FEES`
Fee structures (per class):
`GET /fee-structures` · `PUT /fee-structures/:classId` (monthly + admission; edit)

Challans:
`POST /fees/challans/generate` (edit — scope by class/section/studentIds; optional bulk `examFee`) ·
`GET /fees/challans?classId=&sectionId=&year=&month=&status=&search=` ·
`GET /fees/challans/:id` · `PATCH /fees/challans/:id` (edit — discount/lateFee/dueDate/addItem/removeItemId) ·
`DELETE /fees/challans/:id` (manage — only when unpaid) ·
`POST /fees/challans/mark-overdue` (edit) ·
`POST /fees/challans/mark-paid` (edit — `{ challanIds[], paymentDate, method, note? }`) ·
`GET /fees/challans/:id/pdf` (`?download=1` to attach) · `POST /fees/challans/print` (batch PDF, ≤200 ids)

Payments (the ledger):
`POST /fees/payments` (edit — auto-FIFO or explicit `allocations[]`) ·
`GET /fees/payments?studentId=&from=&to=` ·
`POST /fees/payments/:id/reverse` (manage — requires a reason; row is retained + flagged)

Per-student & dashboard:
`PUT /students/:id/discount` (recurring discount) · `GET /students/:id/fee-ledger` ·
`GET /fees/summary?year=&month=` · `GET /fees/trend?months=` ·
`GET /me/children/:studentId/fees` (PARENT — own child only, read-only) ·
`GET /me/children/:studentId/challans/:challanId/pdf` (PARENT — the printable challan)

**Staff-parent view (decision D4)** — `/api/me/teacher/children`, TEACHER role only:
`GET /` (own children + arrears + latest challan + this month's attendance) ·
`GET /:studentId/fees` · `GET /:studentId/challans/:challanId/pdf`. A teacher sees
how much of their children's fees their salary absorbed and what is still payable
— **never a salary figure**; `/api/salaries/*` stays 403 for them. Every guardian
route re-checks ownership and 404s a challan belonging to a different student.

**Money rules:** every amount is `Decimal(10,2)`; arithmetic uses `Prisma.Decimal`
(`src/utils/money.ts`), and JSON serializes money as fixed-2dp strings. Challans
snapshot `baseAmount`/`discount` at generation. Advance is a **derived** credit
(paid − allocated), auto-applied oldest-month-first when new challans are generated.
Payments run in a **serializable transaction with retry** for concurrent safety.
A student whose parent is a teacher gets `FeeChallan.billedToTeacherId` set — those
fees settle from the teacher's salary in Phase 5B (`staffCovered`), never a status.
Challan PDFs render server-side with **pdfmake 0.2.x** (`fees.pdf.ts`, standard
Helvetica — no font files).

**A `PAID` challan is a closed record** — `PATCH /fees/challans/:id` rejects every edit
with `CHALLAN_PAID` (409). Reverse one of its payments to reopen it.

**`mark-paid` is not a status flip.** It records a real `FeePayment` for each challan's
outstanding balance and allocates it, so the ledger, collection figures and the reversal
path stay honest. Already-settled challans are skipped (safe to re-run), and a partly-paid
challan is charged only its remainder. Used for "this whole class paid at the counter today".

**Generation** (`POST /fees/challans/generate`) builds line items conditionally:
`TUITION` only when the class's monthly fee > 0, `ADMISSION` on the first-ever
challan, `TRANSPORT` for a rider (see below), plus optional bulk `examFee`/`otherFee`
and a `staffChildDiscountPercent`. A student with **no billable items is skipped**
(so a class with no fee structure and no extras produces no challan).
`GET /fees/challans/generate-preview?year=&month=&classId=&sectionId=` returns the
per-class breakdown (students, already-billed, will-generate, fee structure,
staff-child & transport-rider counts, estimated total) that powers the modal.

### Transport — module `FEES`
`GET /transport/routes` · `POST /transport/routes` (edit) ·
`GET /transport/routes/:id` (route + its student & teacher riders + monthly total) ·
`PUT /transport/routes/:id` (edit) · `DELETE /transport/routes/:id` (manage — blocked
while it has riders) · `PUT /transport/assign` (edit — `{ routeId, studentId | teacherId }`,
upserts so it moves a rider between routes) · `DELETE /transport/assign` (edit) ·
`GET /transport/summary`.

`TransportRoute` carries a flat `monthlyFee`; `TransportAssignment` links **exactly
one** of a student or a teacher (`@unique` on each ⇒ one route per person). A student
rider's fee becomes a `TRANSPORT` challan line at generation (and rides to the
teacher-parent's salary if it's a staff child, via `billedToTeacherId`); a teacher
rider's fee is a salary deduction handled at payroll (see Salaries). Deleting a
student/teacher also removes their assignment.

**Linking from the people forms:** `POST|PUT /students/:id` and
`POST|PUT /teachers/:id` accept **`transportRouteId`** (`null` clears it), and both
detail responses return `transport { routeId, name, monthlyFee, active }` — so a
route can be chosen while enrolling a student or hiring a teacher, not only from
the Transport tab.

**The staff-child link is derived, not typed.** `Student.teacherParentId` is set
automatically when the student's parent is also a teacher (on enrolment, and
re-derived whenever the parent changes) — one parent ⇒ one teacher, so the two can
never drift apart. An explicit `teacherParentId` is still accepted for the case
where the registered parent isn't the teacher. `GET /parents` reports `isTeacher`
and `teacherId` so the UI can warn that fees will come out of that salary.

### Salaries — module `SALARIES`
**Admin-only by construction**: teachers are never granted the `SALARIES`
permission, so every route here 403s for them — including their own slip.

`POST /salaries/generate` (edit — `{ year, month, teacherIds? }`, idempotent: skips
teachers who already have a slip) · `GET /salaries?year=&month=&status=` ·
`GET /salaries/:id` (slip **+ deduction breakdown**) · `PUT /salaries/:id` (edit —
allowances/deductions; rejected once PAID) · `PATCH /salaries/:id/status` ·
`GET /salaries/:id/pdf` · `GET /salaries/summary?year=&month=`.

**Staff-fee settlement** (the part worth understanding): a teacher whose children
study here — or who rides a school route — has those fees taken out of their pay
instead of collected in cash.
- Per staff-billed challan, the salary-billable amount is
  `amount − admission items − cash already paid`. **Admission is never billed to a
  salary**; it stays payable by the parent.
- Desired deduction = the teacher's own transport fee + Σ billable across their children.
- `staffFeeDeduction` is **capped so net pay can never go below 0**, then allocated
  **own transport first, then children oldest-first**. Each challan's `staffCovered`
  records what the salary absorbed and its status is recomputed — a partly-covered
  challan becomes `PARTIAL` and the uncovered remainder stays a normal payable
  balance (there is **no** cross-month salary carry).
- `SalarySlip.notes` gets a plain-language explanation, and the slip PDF prints an
  amber callout plus a child-by-child table (fee / from salary / still payable).
- `staffCovered` is a payroll offset and is **never** counted as cash in `/fees/summary`.

**Ordering matters:** generate challans for a month *before* generating salaries —
the settlement only sees challans that exist at generation time, and slips are idempotent.

### Expenses & finance — module `EXPENSES`
`GET /expenses?from=&to=&category=&search=` (list + range total) ·
`POST /expenses` (edit) · `GET /expenses/:id` · `PUT /expenses/:id` (edit) ·
`DELETE /expenses/:id` (manage) · `POST /expenses/:id/receipt` (edit, multipart
field `receipt`) · `GET /expenses/:id/receipt` (authenticated proxy) ·
`GET /expenses/summary?from=&to=` or `?year=&month=` (totals by category) ·
`GET /finance/summary?year=` (month-by-month fees collected vs expenses vs salaries).

Every expense carries **funding rows** recording who actually paid
(`SCHOOL_CASH | SCHOOL_BANK | ADMIN_PERSONAL | TEACHER_PERSONAL | OTHER`, with an
optional `payerId` → User). The rows **must sum exactly to the expense amount** or
the write is rejected (`FUNDING_MISMATCH`); omitting funding auto-inserts a single
`SCHOOL_CASH` row for the full amount, so an expense is never left inconsistent.
Changing the amount revalidates the funding.

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
- **FeeStructure** (per class: monthly + admission) · **FeeChallan** (snapshotted
  `baseAmount`/`discount`/`amount`, `@@unique([studentId, year, month])`,
  optional `billedToTeacherId` + `staffCovered`) · **FeeChallanItem** (typed line
  items) · **FeePayment** → **FeePaymentAllocation** (FIFO ledger; reversal keeps
  the payment row flagged) · **ChallanCounter** (per-year sequential challan no.).
  `Student.feeDiscount`/`teacherParentId` carry recurring discount + staff-child link.
- **TransportRoute** (flat `monthlyFee`) → **TransportAssignment** (exactly one of
  `studentId`/`teacherId`, each `@unique` ⇒ one route per person).
- **SalarySlip** (`@@unique([teacherId, year, month])`, `staffFeeDeduction` + `notes`
  carry the staff-fee settlement) · **Expense** → **ExpenseFunding** (who paid; rows
  always sum to the expense amount).

Money columns are `Decimal(10,2)`, never floats.

### Schema changes — `db push`, no migrations

This project uses **`prisma db push`**, not migrations. There is no
`prisma/migrations/` folder and no `_prisma_migrations` table — the schema is the
single source of truth.

```bash
npx prisma db push     # sync the database to schema.prisma (dev, and on deploy)
npx prisma generate    # regenerate the client (db push runs this for you)
```

`db push` applies **additive** changes (new tables/columns/indexes) silently. If a
change would **lose data** (dropping a column, an incompatible type change, making a
column required on populated rows) it **stops and warns first** — declining, or a
non-interactive shell, aborts it without touching data. It never drops data on its
own; only `--accept-data-loss` would, and we deliberately don't use that flag.

**Why no migrations.** For a single-developer project against one database, the
migration ceremony added friction without payoff, and the history had already
drifted into a state that made `migrate dev` demand a destructive reset. `db push`
plus a seed script covers everything this project needs. If a formal migration
history is ever wanted again, `prisma migrate diff --from-empty --to-schema-datamodel`
regenerates a baseline from the current schema in one command.

**Deploy** is therefore: `git pull → npm install → npx prisma db push` (which also
regenerates the client) → restart the service. Data is preserved.

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
