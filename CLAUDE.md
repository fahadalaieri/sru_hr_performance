# SRU Employee Performance App — جامعة سليمان الراجحي
# Claude Instructions (CLAUDE.md)

## 1) Project Summary
Build a professional **Employee Performance Evaluation System** for Sulaiman Alrajhi University (SRU).

### Core Features:
- Performance evaluation (Goals + Competencies + BAU Tasks + 360° Feedback)
- SRU Official Competency Framework (3 pillars × 3 domains × 3 competencies × 4 behavioral levels)
- Calibration engine (Bell Curve / Forced Distribution)
- Promotions & Rewards module
- Advanced VPRA permissions model (View / Prepare / Recommend / Approve)
- Audit logging for all sensitive actions
- Arabic-first UI (RTL), English secondary (LTR)
- Responsive application can be opened by defferent devices

---

## 2) Tech Stack
| Layer | Technology (as pinned in `package.json`, verified 2026-10-07) |
|-------|-----------|
| Framework | Next.js 16.2.10 (App Router, `proxy.ts` instead of `middleware.ts`) + React 19.2.4 |
| Language | TypeScript 5 (strict mode) |
| Database | Supabase (PostgreSQL + Auth + RLS) via `@supabase/ssr` 0.12 / `@supabase/supabase-js` |
| UI | Tailwind CSS 4 + the SRU kit (`sru-ui.css` / `sru-print.css`) + Lucide icons — **no shadcn/ui** (no `components.json`, no Radix/CVA dependencies) |
| Forms | Native `<form>` + Server Actions (`useActionState`) + Zod 4 — **no React Hook Form** |
| Charts | Hand-written SVG/CSS (org chart, report tiles) — **no Recharts** |
| Export / Import | ExcelJS (xlsx/csv Route Handlers, Excel import actions); PDF via `window.print()` + `sru-print.css` — **not the `xlsx` package** (unpatched advisories, see SESSION_LOG 2026-07-24) |
| i18n | next-intl 4 (AR default + EN, RTL/LTR) |
| State | React state only — **no Zustand** |
| AI | `@anthropic-ai/sdk` (job-description suggestions; needs `ANTHROPIC_API_KEY` at runtime) |
| Tests | Vitest 4, colocated `*.test.ts`; CI runs lint + `tsc --noEmit` + `vitest run` + `next build` |

---

### Supabase Project:
| Key | Value |
|-----|-------|
| Project URL | `https://rrzrrytrdhgmypxjfbmw.supabase.co` |

---

## 2-A) Development Commands
```bash
npm run dev      # Start dev server on localhost:3000
npm run build    # Production build
npm run start    # Serve the production build
npm run lint     # ESLint (flat config: eslint-config-next core-web-vitals + typescript)
```
- Type-check only: `npx tsc --noEmit`
- Lint a single file: `npx eslint <path>`
- Test runner: `npm test` (Vitest, one-shot via `vitest run`). Config: `vitest.config.mts`. Tests are colocated as `*.test.ts` next to the module they cover (e.g. `src/lib/vpra.test.ts`), not under a separate `__tests__/` folder.

## 2-B) Next.js Version Warning
This repo pins **Next.js 16.2.10** and **React 19.2.4** — newer than most training data, with breaking API/convention changes. `AGENTS.md` (repo root) requires reading the matching guide under `node_modules/next/dist/docs/` (`01-app/`, `02-pages/`, `03-architecture/`) before writing any Next.js code. Do not assume Next 13/14/15 patterns (e.g. older routing, config, or caching APIs) still apply — verify against the vendored docs first.

## 2-C) Architecture (Current State, updated 2026-10-07)
- App Router under `src/app/`. Path alias `@/*` → `src/*` (see `tsconfig.json`).
- **Locale routing runs on next-intl** (installed, fully wired — the "hand-rolled" state this section used to describe is gone). `src/i18n/routing.ts` defines the two locales via `defineRouting`; `src/i18n/request.ts` is the `getRequestConfig` referenced by `next.config.ts`'s `createNextIntlPlugin`; `src/i18n/navigation.ts` exports locale-aware `Link`/`usePathname`/`useRouter` (client components must use these, not `next/link`/`next/navigation`, or locale prefixing breaks). `src/proxy.ts` (Next 16 renamed `middleware.ts` → `proxy.ts`) wraps next-intl's `createMiddleware(routing)`. `src/i18n/config.ts` still exports `Locale`/`isLocale`/`getDir`/`locales`/`defaultLocale` for convenience, now derived from `routing.ts` rather than duplicated.
- All UI **chrome** text (nav labels, buttons, page titles/captions) goes through `messages/ar.json` / `messages/en.json` — client components use `useTranslations`, server components use `getTranslations` (or `generateMetadata` + `getTranslations` for `<title>`/meta description, see `src/app/[locale]/layout.tsx`). **Domain data does not** — competency names/definitions (`src/lib/data/competencies.ts`) and org unit names (`src/lib/data/org-units.ts`) are Arabic-only source content extracted from official documents, not UI strings; don't route them through `messages/*.json` or invent English translations for them without real bilingual authoring.
- Two layout tiers under `src/app/[locale]/`: the outer `layout.tsx` is html/body/fonts/theme only (no chrome). A route group `(app)/layout.tsx` mounts `TopBar`/`NavBar` for every page except `login/page.tsx`, which stays a sibling outside `(app)` so it renders full-screen with no admin chrome. New authenticated pages go under `(app)/`; anything that must NOT show the app shell (auth flows, print-only views, etc.) stays outside it.
- `src/app/layout.tsx` (the true root, above `[locale]`) is an intentional pass-through (`return children`, no `<html>`/`<body>`) — keep it that way; `<html>`/`<body>` belong in `[locale]/layout.tsx`. The old `src/app/page.tsx` create-next-app boilerplate has been deleted.
- Theming: `src/components/theme-provider.tsx` wraps `next-themes` pinned to `defaultTheme="light"`, `enableSystem={false}`, matching the "Theme: Light only" rule in section 7 — but `src/app/globals.css` still ships a `.dark` variable block that is currently unreachable. Don't build against it without confirming the light-only rule changed.
- **Color tokens are reconciled**, not competing: `globals.css` imports `sru-ui.css` and `sru-print.css` (the canonical kit from `SRU_IDENTITY.md`) and its own `--color-primary`/`--background`/`--foreground`/`--surface`/`--border`/etc. now alias the real `--sru-*` values instead of ad hoc hex. `sru-ui.css` itself is never edited/overridden — small chrome pieces it doesn't define (`.pill`, `.sru-icon-btn`, `.sru-nav-item` layout, `.sru-topbar-brand`, competency/org-tree component classes) are added additively at the bottom of `globals.css`. One known kit bug worth knowing: `sru-ui.css`'s `.sru-logo` forces a white background box, which is wrong when using the already-white `logo-white.png` on the dark topbar — `TopBar.tsx` uses its own `.sru-topbar-brand` wrapper instead of that class for that reason.
- **Current state, in one place (2026-10-07):** Supabase (Postgres + Auth + RLS) is fully wired with 180+ migrations under `supabase/migrations/`; every business table has RLS with real policies gated by `check_vpra()` / `check_vpra_global()` and a DB-configurable `role_permissions` matrix (edited at runtime from `/admin` — re-query it, never trust a documented snapshot). Modules built and verified live: employees (invite / direct account / approval workflow / Excel import / export), org units + org structure (tree, staffing, chart), career path + job titles + salary scale (real imported data), evaluation cycles + evaluations + scores + 360 (internal and external-token survey), calibration, promotions / rewards / recommendations, vacancies + recruitment (requests, plans with HR/finance/approval workflow, portal), strategic + operational plans with cascaded targets, reports dashboards, notifications, audit log, identity + system settings. Central auth gate lives in `(app)/layout.tsx`; `src/proxy.ts` refreshes the session and excludes `/api`.
- **Where the history went:** the full chronological build-and-verification log that used to live in this section (three paragraphs, ~570 KB) is now [`docs/SESSION_LOG.md`](docs/SESSION_LOG.md), moved verbatim on 2026-10-07. Read it for *why* a decision was taken and *how* it was verified; do not append to it — new work is documented in `HANDOVER.md` (dated entries, PROJECT_STRICT rule) and, when it changes a standing rule, here.
- **Known structural gaps (still open on 2026-10-07):** 10 data migrations cannot replay on a fresh database because they hard-code production UUIDs or assume prior production data (the list and a fresh-database dev bootstrap are documented in `docs/SESSION_LOG.md` and `scripts/dev-seed/`); `feedback_360` is superseded by the `three_sixty_*` module but its table and weight column remain; `ANTHROPIC_API_KEY` must be present at runtime for the AI suggestion features.
- **Multiple parallel Claude sessions have worked on this project** (this repo, a separate design-doc session, and a disconnected React-sandbox prototype — see `HANDOVER.md` §5 for the reconciliation). If you see files or conventions that don't match this document, check `HANDOVER.md` before assuming they're authoritative — CLAUDE.md and `SRU_IDENTITY.md` are the settled reference for everything (colors, roles, competency taxonomy), confirmed by the project owner on 2026-07-14.

---

## 3) Competency Framework (SRU Official)
### Core Pillars:
Client can add pillars

### Competencies:
Client can add competencies
### 3 Types:
1. **الجدارات المؤسسية** (Institutional Competencies) — for all staff
2. **جدارات القيادة** (Leadership Competencies) — for managers and above
3. **الجدارات التخصصية** (Technical/Functional Competencies) — by job family

### 4 Behavioral Levels per competency:
- **أساسي** (Basic) — entry/support roles
- **متوسط** (Intermediate) — jenior/specialist roles
- **متقدم** (Advanced) — senior roles
- **محترف** (Expert) — leadership/professional roles

### Job Families (from provided data):
- Academic / Faculty
- Research / Innovation
- Student Experience
- Administrative
- Financial
- Health
- Technical / IT
- Engineering
- Facilities / Operations

---

## 4) VPRA Permissions Model (Critical)

### Permission Levels:
| Level | Code | Description |
|-------|------|-------------|
| No Access | none | Cannot see or touch |
| View | view | Read-only access |
| Prepare | prepare | Create/edit drafts |
| Recommend | recommend | Submit/recommend upward |
| Approve | approve | Final approval authority |

### Process Areas (Permission Axes):
- `goalsLibrary` — Goals bank management
- `competencyFramework` — Competency definitions
- `defaultTemplates` — Evaluation templates
- `goalAssignment` — Assigning goals to employees
- `bauTasks` — Business-as-usual tasks
- `evaluation` — Running evaluations
- `calibration` — Calibration sessions
- `promotions` — Promotion decisions
- `vacancies` — Vacancy management
- `careerPath` — Career ladder management
- `employeeData` — Employee master data
- `userManagement` — User roles and access

### Roles (DB-stored, configurable):
| Role | Arabic |
|------|--------|
| super_admin | مدير النظام |
| ceo | الرئيس التنفيذي |
| cxo  | رئيس تنفيذي |
| hr_admin | مدير الموارد البشرية |
| strategy_admin | مدير الاستراتيجية |
| competencies_admin | مدير الجدارات |
| committee | لجنة التقييم |
| manager | عميد / مدير |
| supervisor | رئيس مباشر |
| employee | موظف |
| field_supervisor | مشرف ميداني |
| mentor | مرشد |

### Scope:
- Roles are scoped to: **all org units** OR **specific colleges/departments**

## 4-A) Evaluation Lifecycle States

All evaluations follow this state machine:
draft → submitted → supervisor_reviewed → manager_recommended → committee_reviewed → approved → finalized

VPRA enforcement per state:
| State                | Employee | Supervisor | Manager    | Committee  | HR Admin |
|----------------------|----------|------------|------------|------------|----------|
| draft                | prepare  | view       | none       | none       | view     |
| submitted            | view     | prepare    | view       | none       | view     |
| supervisor_reviewed  | view     | view       | recommend  | none       | view     |
| manager_recommended  | view     | view       | view       | recommend  | view     |
| committee_reviewed   | view     | view       | view       | view       | approve  |
| approved             | view     | view       | view       | view       | view     |
| finalized            | view     | view       | view       | view       | view     |

**Rule:** VPRA checks must consider BOTH (permission level) AND (current state).
**Rule:** State transitions are server-side only — never trust client-sent state.

---
## 4-B) Dynamic Roles (Admin-Configurable)

### Concept:
Default roles (section 4) are **seeded defaults only**.
super_admin and hr_admin can create custom roles from the UI.

### Rules for Custom Roles:
1. Every role must have a unique `role_code` (slug, no spaces)
2. Every role must be assigned VPRA permissions per Process Area
3. Every role must have a defined default scope (all / specific org_units)
4. New roles inherit `none` on all Process Areas by default (least privilege)
5. Role names must support Arabic + English labels

### DB Design Required:
```sql  
roles (  
  id, role_code, name_ar, name_en,  
  is_system_role BOOLEAN,  -- true = cannot delete (super_admin, employee...)  
  created_by, created_at  
)  

role_permissions (  
  role_id, process_area, vpra_level  
  -- e.g., (role_id, 'evaluation', 'prepare')  
)  

user_roles (  
  user_id, role_id, scope_type (all | org_unit),  
  org_unit_id NULLABLE,  
  assigned_by, assigned_at  
)  
```

---

## 5) Security Rules (Non-Negotiable)
- ✅ RLS enabled on ALL tables with business data
- ✅ Authorization enforced server-side (never trust client)
- ✅ All secrets in server-only env vars (.env.local)
- ✅ Every sensitive action logged in audit_log table
- ✅ Zod validation on all inputs
- ✅ Least privilege by default
- ❌ No secrets in client components
- ❌ No admin access without audit trail
- ❌ No derived ratings stored without source data

---
## 5-A) Security Enforcement (Mandatory — Based on SECURITY_CHECKLIST.md)

Reference: [SECURITY_CHECKLIST.md](./SECURITY_CHECKLIST.md)

### When touching any auth/permissions/data feature, Claude MUST:
1. Confirm RLS is enabled on all involved tables (`ALTER TABLE x ENABLE ROW LEVEL SECURITY`)
2. Ensure RLS policies are specific — never `USING (true)` on sensitive tables
3. Confirm `anon` role has NO access to sensitive tables
4. Add server-side authorization check (VPRA + scope) — never rely on UI-only protection
5. Add Zod validation for every Server Action / Route Handler input
6. Write an audit_log entry for every sensitive write (evaluation submit, approval, role change…)
7. Use `deleted_at` soft-delete for users/employees — never hard DELETE
8. Confirm no `service_role` key is used in client components
9. Add FK constraints with explicit CASCADE/SET NULL/RESTRICT
10. Add UNIQUE constraints where duplication is invalid (e.g., one evaluation per employee per cycle)

### For Next.js specifically (replaces Netlify/HTML rules):
- Security headers go in `next.config.ts` (headers() function) — not `_headers` file
- No `innerHTML` or `dangerouslySetInnerHTML` without explicit sanitization
- JWT handled by Supabase SSR package (`@supabase/ssr`) — never store in localStorage manually
- All secrets in `.env.local` — only accessible server-side via `process.env`
- Rate limiting on public API routes via middleware or Upstash

### Before every deployment, verify:
- [ ] 1.1 RLS enabled on all tables
- [ ] 1.2 No `USING (true)` policies on sensitive data
- [ ] 1.7 Signup disabled (internal system — invite only)
- [ ] 1.8 No service_role key in client code
- [ ] 3.1 Every Server Action checks auth + VPRA permission
- [ ] 5.1 audit_log captures: login, role change, evaluation submit/approve, calibration finalize
---

## 6) Database Tables (High Level Plan)
```sql  
-- Core  
profiles           -- linked to auth.users  
org_units          -- colleges, departments, units  
job_families       -- academic, admin, financial...  
job_titles         -- with levels (1-14 career ladder)  

-- Permissions  
roles  
permissions        -- VPRA per process area  
role_permissions  
user_roles         -- with org_unit scope  

-- Performance  
evaluation_cycles  
competencies       -- SRU framework  
competency_levels  -- behavioral indicators  
goal_library  
goals              -- assigned goals  
bau_tasks  

-- Evaluation  
evaluations        -- self / manager / 360  
evaluation_scores  
feedback_360  

-- Calibration & Rewards  
calibration_sessions  
calibration_results  
promotions  
rewards  

-- System  
audit_log  
notifications  

---
## 7) UI Identity & Design System

> The single source of truth for all UI is **SRU_IDENTITY.md**.
> Claude MUST read it before touching any UI component.

### Reference Files:
| File | Purpose |
|------|---------|
| `SRU_IDENTITY.md` | Colors, fonts, logo rules, buttons, RTL |
| `sru-ui.css` | UI Kit — import in global CSS, never override |
| `sru-print.css` | Print layout — include on printable pages only |
| `sru-logo.png` | Logo — use per rules in SRU_IDENTITY.md |

### Non-Negotiable UI Rules:
- ✅ RTL direction on all pages (`dir="rtl"`)
- ✅ Font: Cairo (Google Fonts) — `font-family: "Cairo", Tahoma, Arial, sans-serif`
- ✅ Icons: Lucide Icons only
- ✅ Theme: Light only
- ✅ Colors: use CSS variables from `sru-ui.css` — never hardcode hex values
- ❌ Never override `sru-ui.css` classes directly
- ❌ Never use a color outside the SRU palette without approval

---
## 8) بروتوكول العمل (إلزامي)

Reference: [PROJECT_STRICT.md](./PROJECT_STRICT.md)

الملخص التشغيلي:
- كل معلومة غير موثقة تُوسَم: [استنتاج] / [تكهن] / [غير مؤكد]
- قبل أي تعديل: حدد Scope (Task / Will change / Will NOT change / Rollback)
- patch لا rewrite — لا تغيير خارج Scope حتى لو لاحظت مشكلة
- كل SQL داخل BEGIN...COMMIT مع SELECT للتحقق قبل COMMIT
- كل جلسة تنتهي بـ Post-Change Report + تحديث HANDOVER.md

---