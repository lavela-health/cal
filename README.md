# Lavela Cal

The self-hosted Cal instance behind Lavela Health's therapy scheduling and video calls.

**Production:** https://cal.lavelahealth.com

> [!IMPORTANT]
> This fork serves **one** consumer: the `lavela-health/lavela-health` Rails app. It is
> not a general-purpose Cal deployment. Before changing API v2, the managed-user path,
> webhooks, event types, schedules, or the `/video` route, read
> [`agents/lavela-health-integration.md`](agents/lavela-health-integration.md) — it
> documents the response shapes, payload fields and URL formats that consumer depends
> on, **none of which are covered by this repo's tests**. §11 lists the invariants you
> can break without failing a single check here.

---

## What this is

A hard fork of [`calcom/cal.diy`](https://github.com/calcom/cal.diy) (itself Cal.com
with the enterprise edition removed). We do not sync with upstream.

The domain model, in one paragraph:

- **Providers (therapists) are platform-managed users.** Created through
  `POST /v2/oauth-clients/{clientId}/users`, and stored on the Lavela side in
  `external_accounts` alongside their OAuth tokens. This is the only path that creates
  a `User` row here.
- **Clients (patients) are never Cal users.** They exist only as attendees on a
  booking — name, email, timezone, language. No account, no login, and the only Cal
  page they ever see is the video room at `/video/{uid}`.

Several things are deliberately **off** in this deployment:

| Off | How |
|---|---|
| Email | The `emails` kill-switch feature flag, enabled by migration `20260907000000_enable_emails_kill_switch`. `packages/emails/templates/_base-email.ts` checks it before building a transport, so no SMTP config exists. |
| Telemetry | `CALCOM_TELEMETRY_DISABLED=1` |
| Async tasker (Trigger.dev) | `ENABLE_ASYNC_TASKER=false` — tasks execute synchronously |

---

## Architecture

Four services on Render, all in `ohio`, defined by [`render.yaml`](render.yaml):

```
                  cal.lavelahealth.com
                            │
                            ▼
              ┌─────────────────────────┐
              │  cal-web  (web, plan: standard)
              │  Next.js — owns the domain
              │  health: /api/version
              └───────────┬─────────────┘
                          │  Next.js rewrite: /api/v2/* →
                          ▼
              ┌─────────────────────────┐
              │  cal-api  (pserv, standard)
              │  NestJS — API_PORT 10000
              │  private network only
              └───────────┬─────────────┘
                          │
        ┌─────────────────┴─────────────────┐
        ▼                                   ▼
  cal-postgres                        cal-keyvalue
  Postgres 16, basic-1gb              Redis-compatible, starter
                                      maxmemoryPolicy: noeviction
```

**Why the API hides behind web.** Render attaches a custom domain to a single service
and has no path-based router, so the API cannot claim `/api/v2` at the edge. Instead
`cal-web` takes all traffic and the Next.js rewrite
([`apps/web/next.config.ts:373`](apps/web/next.config.ts)) forwards `/api/v2/:path*` to
`NEXT_PUBLIC_API_V2_URL`.

`cal-keyvalue` uses `noeviction` rather than `allkeys-lru` because it backs Bull
queues — evicting job data under memory pressure would silently drop queued work.

---

## Local development

Node comes from [`mise`](https://mise.jdx.dev) (`mise.toml`); Yarn 4.12 via Corepack.

`mise.toml` pins `PORT=3002` for the web app. Next.js resolves its dev port from the
shell environment before `.env` files load, so `NEXT_PUBLIC_WEBAPP_URL` alone cannot
move it off 3000.

### 1. Install and configure

```sh
yarn

cp .env.example .env
openssl rand -base64 32   # → NEXTAUTH_SECRET
openssl rand -base64 24   # → CALENDSO_ENCRYPTION_KEY (must be 32 chars for AES256)
```

Point `.env` at a local Postgres and at the ports this repo actually uses:

```sh
DATABASE_URL='postgresql://<user>:<pass>@localhost:5432/lavela_cal'
DATABASE_DIRECT_URL='postgresql://<user>:<pass>@localhost:5432/lavela_cal'
NEXT_PUBLIC_WEBAPP_URL='http://localhost:3002'
NEXTAUTH_URL='http://localhost:3002'
NEXT_PUBLIC_API_V2_URL='http://localhost:5555/api/v2'
```

> The `database` service in `docker-compose.yml` publishes no host port — it is only
> reachable from inside the compose network. Use your own Postgres (Homebrew, a
> standalone container, whatever), or publish a port yourself.

### 2. Database

```sh
yarn workspace @calcom/prisma db-deploy   # apply migrations
yarn workspace @calcom/prisma db-seed     # test users
```

Seeded logins are `free@example.com` / `free`, `pro@example.com` / `pro`,
`admin@example.com` / `ADMINadmin2022!`. Inspect the rest with `yarn db-studio`.

### 3. Run it

API v2 reads its **own** `apps/api/v2/.env`, separate from the root one — copy
`apps/api/v2/.env.example` and point `DATABASE_URL`, `DATABASE_READ_URL` and
`DATABASE_WRITE_URL` at the same database. It also needs a reachable `REDIS_URL`
(`RedisService` throws `Misconfigured Redis, halting.` without one) and non-empty
`STRIPE_API_KEY` / `STRIPE_WEBHOOK_SECRET` placeholders — billing is unused, but
`getEnv` has no fallback for them and the API will not boot.

Two processes, two terminals:

```sh
yarn dev                                     # web → http://localhost:3002
yarn workspace @calcom/api-v2 dev:no-docker  # API v2 → http://localhost:5555
```

### 4. Before pushing

```sh
yarn type-check:ci --force   # always; run this before blaming CI
yarn biome check --write .   # lint + format
TZ=UTC yarn test             # unit tests (vitest)
```

`TZ=UTC` is not optional — without it, date assertions pass locally and fail in CI.

---

## Deploying

Deploys are **manual, by deliberate choice**. A merge would otherwise build two
multi-GB images and push to a live Render service with nobody watching.

**GitHub → Actions → [Deploy](.github/workflows/deploy.yml) → Run workflow.**

What it does:

1. Builds `ghcr.io/lavela-health/cal-web` and `ghcr.io/lavela-health/cal-api` in
   parallel, each tagged `:<commit-sha>` and `:main`.
2. Deploys **web first**. `scripts/start.sh` runs `prisma migrate deploy` before the
   server listens, so the schema is current before the API serves traffic.
3. Deploys the API, via [`.github/scripts/render-deploy.sh`](.github/scripts/render-deploy.sh),
   pinned to the immutable SHA tag.

A `concurrency: deploy` group prevents two runs from overlapping.

**Rollback** is a redeploy of an older SHA — every deploy pins an immutable tag, so
nothing needs rebuilding. Trigger it through the Render dashboard, or re-run
`render-deploy.sh` with `IMAGE=ghcr.io/lavela-health/cal-web:<older-sha>`.

Required repo secrets: `RENDER_API_KEY`, `RENDER_WEB_SERVICE_ID`,
`RENDER_API_SERVICE_ID`.

### Two things that will cost you an afternoon

**`NEXT_PUBLIC_API_V2_URL` is a build arg, not a runtime variable.** Next.js evaluates
`rewrites()` during `next build` and bakes the result into `routes-manifest.json`.
Changing this value in the Render dashboard does nothing — `/api/v2/*` stays
unrewritten and the API becomes unreachable. It must be changed in `deploy.yml` and
the image rebuilt. `render.yaml` sets the same value only so the two cannot silently
disagree.

**The internal API host carries a generated suffix.** Render gives a private service an
internal hostname like `cal-api-mq7v`, not the bare service name — `cal-api` does not
resolve from `cal-web`. If `cal-api` is ever recreated the suffix changes, and both
`deploy.yml` and `render.yaml` must be updated and the web image rebuilt. Confirm the
current value with `echo $CAL_API_INTERNAL_HOSTPORT` in the `cal-web` shell.

---

## Operations

Two shapes, depending on whether the change is worth keeping.

**Committed and re-runnable** — `scripts/<name>.ts` plus an entry in
`packages/prisma/package.json`, run as `yarn workspace @calcom/prisma <name>`. Take
inputs from env vars, make it idempotent, and state in the file header why it is safe
against production. [`scripts/setup-platform-org.ts`](scripts/setup-platform-org.ts) is
the reference shape. Needs a deploy before it exists on Render.

**One-off, pasted into the Render shell** — when the fix is needed now, with no deploy:

- Run it in **`cal-web`**, not `cal-api`. Both read `DATABASE_URL` from the same
  `cal-postgres`, but cal-web's image copies the full root `node_modules`; cal-api is a
  `pserv` on a slimmer alpine image.
- The working directory is **`/calcom`** — both services are prebuilt images with
  `WORKDIR /calcom`, so Render's native `/opt/render/project/src` does not exist.
- Write the file **inside `/calcom`**, never `/tmp`. Node resolves `require()` from the
  script's own directory, so `/tmp/x.js` cannot see `/calcom/node_modules` no matter
  what you `cd` to first.
- Talk to the database through `pg` directly
  (`new Client({ connectionString: process.env.DATABASE_URL })`). It is hoisted to the
  root `node_modules` and needs no build step.

**Raw SQL naming:** `User` maps to `users` via `@@map`; most other models keep their
PascalCase name and need double quotes — `"SecondaryEmail"`, `"VerificationToken"`.
Check for `@@map` in `packages/prisma/schema.prisma` first.

**Cal Video needs `DAILY_API_KEY` at seed time.** `getDailyAppKeys.ts` reads only from
the `App` table with no env fallback, so a missing key surfaces as a Zod parse failure
when someone starts a session — not at boot.

---

## Working in this repo

| Read | For |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) / [`AGENTS.md`](AGENTS.md) | Engineering conventions, PR rules, the do/don't list |
| [`agents/lavela-health-integration.md`](agents/lavela-health-integration.md) | The consumer contract and its invariants — **keep it in sync in the same PR** |
| [`agents/commands.md`](agents/commands.md) | Full command reference |
| [`agents/rules/`](agents/rules/) | Modular engineering rules (architecture, data, testing, CI) |
| [`agents/knowledge-base.md`](agents/knowledge-base.md) | Domain knowledge and business rules |
| [`specs/`](specs/) | Design docs — `platform-only-mode`, `render-deployment`, `kamal-deployment` |

Layout:

```
apps/web/            Next.js app (App Router in apps/web/app/)
apps/api/v2/         NestJS API v2 — the surface Lavela consumes
packages/prisma/     schema.prisma and migrations
packages/trpc/       tRPC routers
packages/features/   Feature-sliced business logic
packages/platform/   libraries/ re-exports @calcom/features and @calcom/trpc for API v2
```

### Pull requests

Draft by default, conventional-commit title, under 500 lines and 10 code files.

Every PR runs lint, type check, unit tests, API v2 unit tests and a security audit.
Migration checks run only when `packages/prisma/` changes.

Everything heavier is opt-in through the **`ready-for-e2e`** label:

| | |
|---|---|
| Without it | The E2E suites, integration tests, production builds and bundle analysis all skip. The aggregate `required` check then fails **by design**, to stop a merge that never ran E2E. A red `required` with everything else green means the label, not a broken PR. |
| With it | Adds a seeded database, integration tests, web (8 shards) and API v2 (4 shards) E2E, the three production builds and bundle analysis. Roughly 20 minutes. |

Add the label when a change touches booking, availability, event types, schedules or API
v2 behaviour. Skip it for docs, config and test-only changes. Applying it starts a run on
its own — no push needed — and it cancels any run already in flight.

---

## Upstream and license

Forked from [Cal.diy](https://github.com/calcom/cal.diy), the community edition of
[Cal.com](https://cal.com). Both are MIT-licensed, and so is this fork — see
[LICENSE](LICENSE). Upstream's self-hosting, Docker and app-store integration guides
still apply to the parts of the codebase we have not changed.
