# Render setup and first deploy

One-time operator steps for [design.md](./design.md). Everything here happens before the
first automated deploy.

---

## 1. GHCR registry credential

Render pulls the images, so it needs to authenticate to GHCR. `GITHUB_TOKEN` is
job-scoped and cannot be used — create a PAT.

1. GitHub → Settings → Developer settings → Personal access tokens → **classic**, scope
   **`read:packages`** only.
2. Render dashboard → Workspace **Settings → Registry Credentials → Add**:
   - Name: **`ghcr-lavela-health`** (must match `render.yaml` exactly)
   - Registry: GitHub Container Registry
   - Username: your GitHub username
   - Password: the PAT

## 2. Seed the images

The blueprint references `ghcr.io/lavela-health/cal-{web,api}:main`, which must exist
before the first sync or service creation fails on an unpullable image.

Run the **Deploy** workflow manually (`Actions → Deploy → Run workflow`). The two build
jobs will succeed and push both tags; the deploy job will fail because the Render secrets
do not exist yet. That is expected — you only need the images at this point.

Confirm both packages appear under the org's Packages tab.

## Validating render.yaml before you push

Render's prose docs are unreliable on nested fields — they describe `image.creds` as a
plain string, but the API rejects that: it wants
`creds.fromRegistryCreds.name`. Validate against the machine-readable schema instead of
finding out at sync time:

```bash
curl -sfL https://render.com/schema/render.yaml.json -o /tmp/render.schema.json
ruby -ryaml -rjson -e 'puts JSON.generate(YAML.load_file("render.yaml"))' > /tmp/render.json
npx ajv-cli@5 validate -s /tmp/render.schema.json -d /tmp/render.json --spec=draft2020 --strict=false
```

`render blueprints validate` (Render CLI v2.7.0+) does the same thing.

**Schema-valid is necessary, not sufficient.** Render enforces rules the JSON Schema
does not encode, and they only surface at sync time. One already hit us: `pserv` services
reject `healthCheckPath` ("pserv service type cannot have a health check path") because
it is web-only, even though the schema accepts it. Expect sync-time errors to be the real
gate.

Watch for YAML 1.1 booleans while you are here: a bare `off`, `on`, `yes` or `no` parses
as a boolean, so `autoDeployTrigger` must be quoted as `"off"` to stay a string.

## 3. Apply the blueprint

Render dashboard → **New → Blueprint** → select `lavela-health/cal` → it reads
`render.yaml` and creates:

| Resource | Type | Plan |
|---|---|---|
| `cal-web` | Web service | Standard (1 CPU / 2 GB) |
| `cal-api` | Private service | Standard (1 CPU / 2 GB) |
| `cal-keyvalue` | Key Value | Starter (256 MB) |
| `cal-postgres` | Postgres | basic-1gb |
| `cal-common` | Env var group | — |

Services will fail to start until §4 is done. Expected.

## 4. Fill the `sync: false` values

Every variable declared `sync: false` must be set by hand in the dashboard.

Generate the fresh ones:

```bash
openssl rand -base64 32   # NEXTAUTH_SECRET
openssl rand -base64 32   # JWT_SECRET
openssl rand -base64 32   # CRON_API_KEY
openssl rand -base64 24   # CALENDSO_ENCRYPTION_KEY  (32 chars, AES256)
openssl rand -base64 24   # CALCOM_SERVICE_ACCOUNT_ENCRYPTION_KEY
```

> **`NEXTAUTH_URL` must be set on `cal-api`, not just `cal-web`.** It is in the
> blueprint, but it is worth knowing why: `ApiAuthStrategy` authenticates the Platform
> dashboard with next-auth's `getToken()`, which derives the session cookie name from
> `NEXTAUTH_URL` — `https://` yields `__Secure-next-auth.session-token`, anything else
> yields `next-auth.session-token`. `cal-web` is https and sets the `__Secure-` name, so
> if the API lacks the variable it looks for a cookie that does not exist and every
> dashboard request fails with 401 "No authentication method provided". This works
> locally only because both sides are http and the two names coincide, so it will not
> reproduce in development.

> **These three must be byte-identical on `cal-web` and `cal-api`:**
> `NEXTAUTH_SECRET`, `CALENDSO_ENCRYPTION_KEY`, `CALCOM_SERVICE_ACCOUNT_ENCRYPTION_KEY`.
> The API validates sessions minted by web and decrypts credentials web encrypted. A
> mismatch fails at runtime, on real user traffic, not at boot.

**`cal-web`:**

| Variable | Value |
|---|---|
| `NEXTAUTH_SECRET` | generated — same as api |
| `CALENDSO_ENCRYPTION_KEY` | generated — same as api |
| `CALCOM_SERVICE_ACCOUNT_ENCRYPTION_KEY` | generated — same as api |
| `CRON_API_KEY` | generated |
| `CALCOM_LICENSE_KEY` | copy from `apps/api/v2/.env` |
| `DAILY_API_KEY` | copy from `.env` |
| `DATABASE_HOST` | see below |

**`cal-api`:** the three shared secrets above, plus `JWT_SECRET`,
`CALCOM_LICENSE_KEY`, `DAILY_API_KEY`, and `STRIPE_API_KEY` / `STRIPE_WEBHOOK_SECRET`.

> **Stripe is mandatory even though billing is unused.**
> `apps/api/v2/src/config/app.ts` reads both through `getEnv` with no fallback and
> `getEnv` throws, so the API will not boot without them. `sk_test_placeholder` and
> `whsec_placeholder` are fine.
>
> Never reuse the values from upstream's `calcom/docker` blueprint — it publishes
> `NEXTAUTH_SECRET: secret`, `CALENDSO_ENCRYPTION_KEY: secret` and a literal
> `CRON_API_KEY` in a public repo.

### `DATABASE_HOST`

`scripts/start.sh` runs `wait-for-it.sh $DATABASE_HOST` before migrating. Render
generates the hostname, so take it from `cal-postgres` → Connections → internal hostname
and set:

```
<internal-host>:5432
```

`start.sh` has no `set -e`, so a wrong value is noisy rather than fatal — migrations
still run. Setting it correctly just avoids a misleading error in the boot log.

## 5. Custom domain

`cal-web` → Settings → Custom Domains → add `cal.lavelahealth.com`, then create the DNS
record Render shows (a CNAME to `<service>.onrender.com`).

Render issues and renews the certificate. Confirm before deploying:

```bash
dig +short cal.lavelahealth.com
```

Do **not** add a domain to `cal-api` — it is private by design and reached only through
web's rewrite.

## 6. Email — disabled by design, nothing to configure

This instance sends no email. The platform owns all patient and therapist
communication, so booking mail from Cal would be duplicate and off-brand.

This is enforced properly rather than by leaving SMTP broken. `emails` is a
`KILL_SWITCH` feature flag, seeded `false` by
`20230303195432_add_feature_flag_default_values`; migration
`20260907000000_enable_emails_kill_switch` flips it to `true`. Note the inverted
polarity — for this flag, **enabled = true means "prevent any emails being sent"**.

`BaseEmail.sendEmail()` checks the flag before constructing a transport, so all 25
templated email types short-circuit with no SMTP configuration and no failed
connections in the logs.

Nothing to do here. To re-enable later, toggle the flag off in the admin feature-flags
UI and set `EMAIL_SERVER_HOST` / `_PORT` / `_USER` / `_PASSWORD` on `cal-web`.

### Two paths the kill switch does not cover

`packages/features/auth/lib/sendVerificationRequest.ts` builds its own nodemailer
transport and does **not** consult the flag. It is reached from:

- NextAuth's Email provider — magic-link sign-in
- `packages/app-store/stripepayment/api/paymentCallback.ts` — Stripe payments

Neither should fire here: users are provisioned as managed users through API v2 and
authenticate via the platform, and Stripe payments are unused. If either is ever
exercised, it will attempt `/usr/sbin/sendmail`, which is absent from the `node:20`
image, and fail with ENOENT. In practice that means **magic-link email sign-in does not
work on this deployment** — which is consistent with the platform owning auth.

## 7. GitHub secrets for automated deploys

Take the service IDs from each service's dashboard URL
(`https://dashboard.render.com/web/srv-XXXXXXXX` → `srv-XXXXXXXX`).

| Secret | Value |
|---|---|
| `RENDER_API_KEY` | Render → Account Settings → API Keys |
| `RENDER_WEB_SERVICE_ID` | `srv-…` for `cal-web` |
| `RENDER_API_SERVICE_ID` | `srv-…` for `cal-api` |

`KAMAL_REGISTRY_PASSWORD`, `SSH_PRIVATE_KEY`, `SSH_KNOWN_HOSTS`, `POSTGRES_PASSWORD` and
the `DATABASE_*` / `REDIS_URL` secrets from the droplet plan are **not** needed — Render
injects connection strings from the managed database and Key Value instance.

## 8. First deploy

Re-run the **Deploy** workflow (`Actions → Deploy → Run workflow`). It builds both
images, then deploys web (which applies `prisma migrate deploy` on boot) and then the
API.

> Deploys are **manual by design** — `deploy.yml` has no `push` trigger, so merging to
> `main` never deploys. Every release is an explicit run of this workflow.

Verify:

```bash
curl -sI https://cal.lavelahealth.com/api/version    # 200, web is up
curl -sI https://cal.lavelahealth.com/api/v2/health  # 200, rewrite reaches the API
```

The second is the one that matters — it proves the Next.js rewrite is reaching `cal-api`
over Render's private network. It is also the only health signal for the API: Render does
not health-check private services, and marks `cal-api` live as soon as it binds its port,
so a booted-but-broken API would look healthy in the dashboard. Check this endpoint after
every API deploy. If it 502s, check that `API_PORT` is `10000` on `cal-api`
and that `NEXT_PUBLIC_API_V2_URL` on `cal-web` is `http://cal-api:10000/api/v2`.

## 9. Immediately after

The database starts empty; nothing can log in yet.

1. Create the admin user, platform organization and OAuth client — or restore a
   `pg_dump` of the local `lavela_cal` database.
2. Register OAuth redirect URIs with each provider you enable. They resolve under
   `https://cal.lavelahealth.com/api/v2/...`.
3. Confirm Postgres backups are on and note the retention window.
4. Point the platform's `:self_hosted_cal` host config at `cal.lavelahealth.com` — see
   `agents/lavela-health-integration.md`.

## Rollback

Deploys are pinned to a commit SHA, so rolling back is redeploying an older image:

```bash
curl -X POST "https://api.render.com/v1/services/$SERVICE_ID/deploys" \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"imageUrl":"ghcr.io/lavela-health/cal-web:<older-sha>"}'
```

Roll back the API the same way. Note that a schema migration is **not** reversed by an
image rollback — check whether the older image tolerates the current schema.
