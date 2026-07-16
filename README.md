# Qirop School ERP — Backend (Phase 0)

REST API + database foundation for **Qirop School of Wisdom & Technology**.
This phase delivers the full Prisma schema and the authentication/authorization
system only — feature modules (students, fees, attendance, …) come in later phases.

## Stack

Node.js + TypeScript · Express 4 · Prisma 6 · PostgreSQL · bcrypt · JWT (httpOnly
cookie) · zod · helmet · cors · express-rate-limit.

## Getting started

```bash
cd backend
cp .env.example .env        # then fill in DATABASE_URL, JWT_SECRET, superadmin creds
npm install
npm run prisma:generate
npm run prisma:migrate      # creates all tables/enums (migration "init")
npm run prisma:seed         # school, superadmin, classes/sections/subjects/fees
npm run dev                 # http://localhost:4000
```

> **Database URL** — currently a single direct PostgreSQL connection
> (`DATABASE_URL`). A pgbouncer pooler + separate `DIRECT_URL` for migrations will
> be reintroduced in a later phase.

To also seed a sample teacher/parent/student (for testing login flows), set
`SEED_SAMPLE="true"` in `.env` before seeding. Sample password: `Password#123`.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Dev server with watch (tsx) |
| `npm run build` / `npm start` | Compile to `dist/` and run |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run prisma:migrate` | `prisma migrate dev --name init` |
| `npm run prisma:seed` | Run the idempotent seed |
| `npm run prisma:studio` | Open Prisma Studio |

## API

| Method | Route | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/api/health` | — | DB connectivity check |
| POST | `/api/auth/login` | — | `{ cnic, password }` → sets httpOnly cookie; rate-limited |
| POST | `/api/auth/logout` | — | Clears the cookie |
| GET | `/api/auth/me` | cookie | Current user + permissions (no `passwordHash`, no teacher `salary`) |
| POST | `/api/auth/change-password` | cookie | `{ currentPassword, newPassword }` |
| GET | `/api/admin/ping` | SUPERADMIN/ADMIN | RBAC test route |

Errors are always `{ error: { message, code } }`.

## Authorization model

- **SUPERADMIN** — implicit full access (all modules, all actions).
- **ADMIN** — per-module `AdminPermission` rows (`canView` / `canEdit` / `canManage`,
  hierarchical: manage ⇒ edit ⇒ view).
- **TEACHER / PARENT** — no module permissions; scoped access enforced per-feature later.

Middleware: `requireAuth`, `requireRole(...roles)`, `requirePermission(module, action)`.

## Verification status (Phase 0 checklist)

Verified live against the database:

- ✅ Install, `prisma generate` (Prisma Client v6), migrate (`init`), seed (idempotent — run repeatedly, no duplicates)
- ✅ 22 models + 9 enums created; money columns are `numeric(10,2)` (Decimal, not Float)
- ✅ `/api/health` → DB connected
- ✅ Login: correct → 200 + cookie; wrong → 401 (generic `Invalid CNIC or password`)
- ✅ `/me` with cookie → SUPERADMIN + full permissions, **no `passwordHash` / `salary`**; without cookie → 401
- ✅ RBAC: `/api/admin/ping` with superadmin cookie → 200
- ✅ Change password: old fails / new works afterwards
- ✅ CNIC `@unique` enforced

Pending (needs multiple roles, arrives next phase): TEACHER/PARENT → 403 on admin routes.
