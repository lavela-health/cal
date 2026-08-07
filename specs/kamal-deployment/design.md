# Kamal deployment to a DigitalOcean droplet

**Status:** Design approved, not implemented
**Date:** 2026-08-07

## Goal

Deploy this monorepo to a single DigitalOcean droplet with Kamal 2, serving both the
web app and API v2 from `cal.lavelahealth.com`, so an external Platform app can consume
API v2 against the same domain. Postgres runs on the same droplet and keeps its data
across deploys.

## Decisions

| Question | Decision |
|---|---|
| Routing | One host. kamal-proxy path routing sends `/api/v2/*` to the API container, everything else to web |
| Image builds | GitHub Actions builds amd64 images and pushes to GHCR |
| Deploy trigger | Full CD: push to `main` builds, then runs `kamal deploy` from the runner |
| Secrets | ~25 runtime secrets live in GitHub Actions secrets |
| Initial DB | Empty, migrations applied on boot. Seeding is a separate follow-up |
| Droplet spec | Deferred to the operator. Builds run in CI, so the box only carries runtime |

Rejected alternatives are recorded in [Appendix A](#appendix-a--rejected-alternatives).

## 1. Topology

```
              cal.lavelahealth.com  (DNS A -> droplet)
                        |
                   kamal-proxy  :80/:443  <- Let's Encrypt
                        |
        +---------------+----------------+
   /api/v2/*                            /*
        |                                |
   cal-api (NestJS :80)          cal-web (Next.js :3000)
        |        |                       |
        +--------+-----------------------+
                 |
      cal-postgres:5432      cal-redis:6379
```

All containers sit on Kamal's default `kamal` bridge network, so accessories are
reachable by container name.

`strip_path_prefix: false` keeps the `/api/v2` prefix on forwarded requests, which the
API's own `RewriterMiddleware` (`apps/api/v2/src/middleware/app.rewrites.middleware.ts`)
maps to `/v2` — identical to the current local behaviour.

### Two Kamal configs, one proxy

Kamal binds one image per app, so the web and API apps are two configs sharing the
droplet's single kamal-proxy. The proxy docs confirm this is supported: proxy options
"are application-specific, so they are not shared when multiple applications run on the
same proxy."

| File | `service` | Image | Owns |
|---|---|---|---|
| `config/deploy.yml` | `cal` | `ghcr.io/lavela-health/cal-web` | web app + both accessories |
| `config/deploy.api.yml` | `cal-api` | `ghcr.io/lavela-health/cal-api` | API v2 only |

Accessories are declared in the web config, which names their containers `cal-postgres`
and `cal-redis`. The API config references those hostnames.

### Health checks and timing

| App | Path | Notes |
|---|---|---|
| web | `/api/version` | Exists at `apps/web/app/api/version/route.ts`, returns a cheap JSON 200 |
| API v2 | `/health` | Exists at `apps/api/v2/src/app.controller.ts`, version-neutral |

`scripts/start.sh` runs `prisma migrate deploy` and `seed-app-store.ts` on every web
container boot before the server listens, so `deploy_timeout` must be raised well above
the 10s default (~300s). `deploy_timeout` and `drain_timeout` are **top-level** Kamal
keys; `healthcheck` lives under `proxy:`.

## 2. Repository changes

### 2.1 `Dockerfile` — add missing build args

The web Dockerfile threads through only ~8 `NEXT_PUBLIC_*` values. Next.js inlines these
at build time, so anything not passed as a build arg falls back to the Cal.com default in
the shipped bundle — including this deployment's branding.

Add `ARG` + `ENV` pairs for:

```
NEXT_PUBLIC_APP_NAME
NEXT_PUBLIC_COMPANY_NAME
NEXT_PUBLIC_SUPPORT_MAIL_ADDRESS
NEXT_PUBLIC_WEBSITE_URL
NEXT_PUBLIC_EMBED_LIB_URL
NEXT_PUBLIC_MINUTES_TO_BOOK
NEXT_PUBLIC_BOOKER_NUMBER_OF_DAYS_TO_LOAD
NEXT_PUBLIC_INVALIDATE_AVAILABLE_SLOTS_ON_BOOKING_FORM
NEXT_PUBLIC_QUICK_AVAILABILITY_ROLLOUT
NEXT_PUBLIC_FORMBRICKS_HOST_URL
```

Existing args (`NEXT_PUBLIC_WEBAPP_URL`, `NEXT_PUBLIC_API_V2_URL`,
`NEXT_PUBLIC_LICENSE_CONSENT`, `NEXT_PUBLIC_WEBSITE_TERMS_URL`,
`NEXT_PUBLIC_WEBSITE_PRIVACY_POLICY_URL`, `NEXT_PUBLIC_SINGLE_ORG_SLUG`,
`ORGANIZATIONS_ENABLED`, `CALCOM_TELEMETRY_DISABLED`, `CSP_POLICY`,
`MAX_OLD_SPACE_SIZE`) stay as they are.

### 2.2 `apps/api/v2/src/app.module.ts` — fix the Redis TLS assumption

Line 38 currently reads:

```ts
BullModule.forRoot({
  redis: `${process.env.REDIS_URL}${process.env.NODE_ENV === "production" ? "?tls=true" : ""}`,
}),
```

Against a plain Redis on the same host this appends `?tls=true` and breaks the Bull
connection used by `selected-calendars.module.ts`. It is not hit locally because
`apps/api/v2/.env` sets `NODE_ENV=development`.

Fix: pass `process.env.REDIS_URL` through unchanged and let the URL scheme decide —
`rediss://` means TLS, which is the form managed Redis providers hand out anyway. One
line, strictly more correct, and a divergence from upstream worth recording in the commit
message.

### 2.3 New files

- `config/deploy.yml`
- `config/deploy.api.yml`
- `.kamal/secrets` (reads from the process env; gitignored)
- `.github/workflows/deploy.yml`

## 3. Kamal configuration

### 3.1 `config/deploy.yml` (web + accessories)

```yaml
service: cal
image: lavela-health/cal-web

registry:
  server: ghcr.io
  username: <github-user>
  password:
    - KAMAL_REGISTRY_PASSWORD

builder:
  arch: amd64

servers:
  web:
    - <droplet-ip>

proxy:
  ssl: true
  host: cal.lavelahealth.com
  app_port: 3000
  healthcheck:
    path: /api/version
    interval: 5
    timeout: 5

deploy_timeout: 300
drain_timeout: 30

env:
  clear:
    # ... Bucket B, see section 5
  secret:
    # ... Bucket C, see section 5

accessories:
  postgres:
    image: postgres:16
    host: <droplet-ip>
    env:
      clear:
        POSTGRES_USER: calcom
        POSTGRES_DB: calcom
      secret:
        - POSTGRES_PASSWORD
    directories:
      - data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    host: <droplet-ip>
    cmd: redis-server --appendonly yes
    directories:
      - data:/data
```

Kamal's `directories` creates host bind mounts (e.g. `/root/cal-postgres/data`), which
survive every `kamal deploy` and are straightforward to back up.

> The repo's `docker-compose.yml` mounts the *parent* `/var/lib/postgresql` rather than
> `/var/lib/postgresql/data`. That is a long-standing Cal.com quirk that does not persist
> reliably. Use the correct path.

### 3.2 `config/deploy.api.yml` (API v2)

Same `registry`, `builder` and `servers`, with:

```yaml
service: cal-api
image: lavela-health/cal-api

proxy:
  ssl: true
  host: cal.lavelahealth.com
  app_port: 80
  path_prefix: "/api/v2"
  strip_path_prefix: false
  healthcheck:
    path: /health
    interval: 5
    timeout: 5

deploy_timeout: 180
```

No accessories — it consumes `cal-postgres` and `cal-redis` from the web config.

## 4. CI/CD

`.github/workflows/deploy.yml`, triggered by push to `main` and `workflow_dispatch`:

```
build-web ---+
             +--> deploy  (needs: build-web, build-api)
build-api ---+        kamal deploy -c config/deploy.yml     --version=$SHA --skip-push
                      kamal deploy -c config/deploy.api.yml --version=$SHA --skip-push
```

- Both build jobs use `docker/build-push-action` with GitHub Actions layer caching,
  tagging `ghcr.io/lavela-health/cal-{web,api}:${{ github.sha }}`.
- `--skip-push` tells Kamal the image already exists in the registry, so it pulls rather
  than builds.
- `concurrency: { group: deploy, cancel-in-progress: false }` prevents two merges racing
  the Kamal lock.
- GHCR auth uses the built-in `GITHUB_TOKEN`. SSH uses a dedicated deploy key from
  repository secrets.
- The two `kamal deploy` calls run sequentially in one job. Web goes first so migrations
  are applied before the API starts serving.

## 5. Environment variables

Grouped by *where the value must exist*, which is what determines whether it is a secret.

### Bucket A — web image build args (public, plain `env:` in the workflow)

Next.js inlines these into the client bundle at build time; Kamal cannot set them later.
All are public by definition, so they belong in the workflow file rather than in secrets.

```
NEXT_PUBLIC_WEBAPP_URL=https://cal.lavelahealth.com
NEXT_PUBLIC_WEBSITE_URL=https://cal.lavelahealth.com
NEXT_PUBLIC_APP_NAME=Lavela Cal
NEXT_PUBLIC_COMPANY_NAME=Lavela Health
NEXT_PUBLIC_SUPPORT_MAIL_ADDRESS=hello@lavelahealth.com
NEXT_PUBLIC_EMBED_LIB_URL
NEXT_PUBLIC_LICENSE_CONSENT
NEXT_PUBLIC_BOOKER_NUMBER_OF_DAYS_TO_LOAD
NEXT_PUBLIC_MINUTES_TO_BOOK
NEXT_PUBLIC_INVALIDATE_AVAILABLE_SLOTS_ON_BOOKING_FORM
NEXT_PUBLIC_QUICK_AVAILABILITY_ROLLOUT
NEXT_PUBLIC_IS_PREMIUM_NEW_PLAN
NEXT_PUBLIC_ORGANIZATIONS_MIN_SELF_SERVE_SEATS
NEXT_PUBLIC_ORGANIZATIONS_SELF_SERVE_PRICE_NEW
NEXT_PUBLIC_FORMBRICKS_HOST_URL
NEXT_PUBLIC_SINGLE_ORG_SLUG
ORGANIZATIONS_ENABLED
CALCOM_TELEMETRY_DISABLED
CSP_POLICY
MAX_OLD_SPACE_SIZE=6144
```

Plus three throwaway args the Dockerfile requires but that never reach the bundle —
dummy values are correct here:

```
DATABASE_URL=postgresql://build:build@localhost:5432/build
NEXTAUTH_SECRET=build-only
CALENDSO_ENCRYPTION_KEY=build-only
```

The API v2 image likewise needs only dummy `DATABASE_URL` / `DATABASE_DIRECT_URL`, used
solely by `prisma generate`.

**Neither image build requires a real secret.**

> `NEXT_PUBLIC_API_V2_URL` is deliberately *not* in this bucket despite its
> `NEXT_PUBLIC_` prefix. Its only consumer is `apps/web/next.config.ts:371`, and
> `next.config.ts` runs in Node at server start rather than being bundled — so it is a
> runtime variable. It appears in Bucket B instead. The Dockerfile's existing `ARG` for it
> is harmless; a Kamal-supplied runtime value overrides the baked `ENV`.

### Bucket B — runtime, non-secret (Kamal `env: clear`)

| Variable | Value | Container |
|---|---|---|
| `NODE_ENV` | `production` | both |
| `NEXT_PUBLIC_WEBAPP_URL` | `https://cal.lavelahealth.com` | web |
| `BUILT_NEXT_PUBLIC_WEBAPP_URL` | same as above | web |
| `NEXTAUTH_URL` | `https://cal.lavelahealth.com` | web |
| `DATABASE_HOST` | `cal-postgres:5432` | web |
| `NEXT_PUBLIC_API_V2_URL` | unset (see below) | web |
| `ALLOWED_HOSTNAMES` | `"cal.lavelahealth.com"` | web |
| `EMAIL_FROM`, `EMAIL_FROM_NAME` | as configured | web |
| `EMAIL_SERVER_HOST`, `EMAIL_SERVER_PORT` | SMTP provider | web |
| `GOOGLE_LOGIN_ENABLED` | as configured | web |
| `TRIGGER_API_URL`, `ENABLE_ASYNC_TASKER` | as in `.env` | both |
| `RESERVED_SUBDOMAINS`, `CRON_ENABLE_APP_SYNC` | as in `.env` | web |
| `TZ` | as in `.env` | both |
| `API_PORT` | `80` | api |
| `API_URL` | `https://cal.lavelahealth.com/api` | api |
| `WEB_APP_URL` | `https://cal.lavelahealth.com` | api |
| `API_KEY_PREFIX` | `cal_` | api |
| `LOG_LEVEL`, `LOGGER_BRIDGE_LOG_LEVEL` | as configured | api |
| `REWRITE_API_V2_PREFIX` | `1` | api |
| `IS_E2E` | `false` | api |

Setting `BUILT_NEXT_PUBLIC_WEBAPP_URL` equal to `NEXT_PUBLIC_WEBAPP_URL` makes
`scripts/replace-placeholder.sh` a no-op at boot, saving a slow find/replace pass over
`.next`.

#### `NEXT_PUBLIC_API_V2_URL` is left unset in the primary design

kamal-proxy intercepts `/api/v2/*` before the request ever reaches Next.js, so the rewrite
at `apps/web/next.config.ts:371` never fires. Leaving the variable unset makes that
explicit — the rewrite is not registered at all, and there is no chance of a
web-rewrites-to-itself loop if the proxy route is ever misconfigured.

It becomes relevant only in the section 7 fallback.

#### `API_URL` must include the `/api` prefix

`apps/api/v2/src/config/app.ts:20` computes `api.url` as `${API_URL}/v2` in production,
and that value is used to build **OAuth redirect URIs**:

- `platform/calendars/services/gcal.service.ts:27` — Google Calendar
- `platform/calendars/services/outlook.service.ts:24` — Outlook
- `modules/conferencing/services/zoom-video.service.ts:22` — Zoom
- `modules/conferencing/services/office365-video.service.ts:22` — Office 365 video
- `modules/stripe/stripe.service.ts:38` — Stripe

With `API_URL=https://cal.lavelahealth.com` those resolve to
`https://cal.lavelahealth.com/v2/...`, which the proxy does **not** route (only `/api/v2`
is mapped). Setting `API_URL=https://cal.lavelahealth.com/api` makes them resolve to
`https://cal.lavelahealth.com/api/v2/...`, matching the proxy route.

`config.api.path` (the raw `API_URL`) has no other consumers, so overloading it this way
is safe.

These redirect URIs must also be registered with each provider (Google Cloud console,
Azure app registration, Zoom app, Stripe Connect).

### Bucket C — runtime secrets (GitHub Actions secrets -> `.kamal/secrets`)

```
POSTGRES_PASSWORD
DATABASE_URL              postgresql://calcom:<pw>@cal-postgres:5432/calcom
DATABASE_DIRECT_URL       same as DATABASE_URL
DATABASE_READ_URL         same as DATABASE_URL
DATABASE_WRITE_URL        same as DATABASE_URL
REDIS_URL                 redis://cal-redis:6379/1
NEXTAUTH_SECRET
CALENDSO_ENCRYPTION_KEY
JWT_SECRET
CRON_API_KEY
CALCOM_SERVICE_ACCOUNT_ENCRYPTION_KEY
CALCOM_LICENSE_KEY
GOOGLE_API_CREDENTIALS
MS_GRAPH_CLIENT_ID
MS_GRAPH_CLIENT_SECRET
EMAIL_SERVER_USER
EMAIL_SERVER_PASSWORD
STRIPE_API_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PRIVATE_KEY
STRIPE_CLIENT_ID
DAILY_API_KEY
DAILY_WEBHOOK_SECRET
KAMAL_REGISTRY_PASSWORD   (the GITHUB_TOKEN)
SSH_PRIVATE_KEY           (deploy key)
```

#### Variables that abort API v2 boot if missing

`apps/api/v2/src/config/app.ts` calls `getEnv` with **no fallback** for these, and
`getEnv` throws on a missing value:

`DATABASE_READ_URL`, `DATABASE_WRITE_URL`, `REDIS_URL`, `NEXTAUTH_SECRET`,
`STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`.

`STRIPE_API_KEY` and `STRIPE_WEBHOOK_SECRET` are mandatory even if Stripe is unused.
Additionally `RedisService` throws `"Misconfigured Redis, halting."` without `REDIS_URL`.

#### Gaps versus the current local setup

- `CALCOM_LICENSE_KEY` is set in `apps/api/v2/.env` but absent from the root `.env`. The
  web app needs it for EE/Platform features, so supply it to **both** containers.
- `JWT_SECRET` and `CALCOM_SERVICE_ACCOUNT_ENCRYPTION_KEY` exist only in
  `apps/api/v2/.env`.
- `EMAIL_SERVER_HOST` is `localhost:1025` locally (MailHog). Production needs a real SMTP
  provider; until one is configured, outbound email silently fails. Provider choice is
  out of scope here.

## 6. Persistence and data

- **Postgres** — `postgres:16` accessory with a host bind mount. Accessories are only
  touched by explicit `kamal accessory` commands, so `kamal deploy` never disturbs the
  data. No Postgres extensions are required (no `CREATE EXTENSION` in
  `packages/prisma/migrations/`), so the stock image is sufficient.
- **Redis** — `redis:7-alpine` with `--appendonly yes` and a bind mount at `/data`.
- **Schema** — `prisma migrate deploy` runs from `scripts/start.sh` on every web boot.
  Idempotent, but it is why the deploy timeout is raised.
- **Initial data** — the database starts empty. Creating the admin user, platform
  organization and OAuth client (or restoring a `pg_dump` of the local `lavela_cal`
  database) is a deliberate follow-up, tracked separately.
- **Disk** — Kamal retains previous image versions for rollback and these images are
  multi-GB. Size the droplet volume accordingly and prune periodically.

### Backups are not in scope

A containerized Postgres with no backup is a real exposure. A `pg_dump` cron to DO Spaces
is the recommended fast follow-up but is deliberately excluded from this plan.

## 7. Open risk requiring live verification

Both apps register the **same host** with kamal-proxy, and only one can drive the Let's
Encrypt certificate. kamal-proxy documents path-based routing and multiple apps per proxy
independently, but not the interaction of two services claiming one host with
`ssl: true`.

**Verification step, on first deploy:** deploy `cal` first, confirm the certificate is
issued, then deploy `cal-api` and confirm the certificate is *not* re-requested. Let's
Encrypt rate limits are unforgiving, so do this deliberately rather than by repeated
retries.

**Fallback if it misbehaves:** drop the API's proxy registration and use Cal.com's
built-in path instead. `cal-web` takes all traffic on the host, and the Next.js rewrite at
`apps/web/next.config.ts:371` forwards `/api/v2/:path*` to `${NEXT_PUBLIC_API_V2_URL}/:path*`.

This needs three changes in `config/deploy.api.yml`, not just one:

1. Remove the `proxy:` block so the API is no longer registered with kamal-proxy.
2. **Give the API container a stable network alias.** Kamal names app containers
   `<service>-<role>-<version>` (`Kamal::Configuration::Role#container_name`), so unlike
   accessories they have no stable DNS name to target. Add one via role options:

   ```yaml
   servers:
     web:
       hosts:
         - <droplet-ip>
       options:
         network-alias: cal-api-internal
   ```

   During a rolling deploy two containers briefly share the alias and Docker DNS
   round-robins between them. Both are healthy, so this is acceptable.
3. Set `NEXT_PUBLIC_API_V2_URL=http://cal-api-internal/api/v2` on the **web** app.

This costs one internal hop. It is configuration only — no rebuild — because
`NEXT_PUBLIC_API_V2_URL` is read at server start, not baked into the bundle (see section
5, Bucket A note).

`API_URL` stays `https://cal.lavelahealth.com/api` in either topology, so OAuth redirect
URIs are unaffected by the switch and do not need re-registering with providers.

## 8. Out of scope

Droplet provisioning and sizing, DNS records, database seeding, backups, SMTP provider
selection, a staging environment, monitoring and alerting.

---

## Appendix A — rejected alternatives

**Routing.** Sending all traffic to web and relying on the Next.js `/api/v2` rewrite was
rejected in favour of proxy path routing, which avoids a Node hop on every API call and
gives each service an independent health check. It is retained as the documented fallback
in section 7. A separate `api.lavelahealth.com` subdomain was rejected because the
requirement is to consume both from one domain.

**Build location.** A Kamal remote builder on the droplet was rejected because builds
would compete with production for CPU and memory. Building on the Mac was never viable:
it is arm64, the droplet is amd64, and cross-building the web image under QEMU emulation
is impractical.

**Secrets.** Keeping secrets local and deploying by hand was rejected in favour of full
CD. The cost is that secrets exist in two places and must be kept in sync on rotation.
