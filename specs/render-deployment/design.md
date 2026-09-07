# Render deployment

**Status:** Implemented — Render workspace setup pending
**Date:** 2026-09-07

Supersedes [../kamal-deployment/design.md](../kamal-deployment/design.md). That
document's analysis of environment variables, boot-time invariants and OAuth redirect
URIs still holds and is not repeated here; only the hosting decisions changed.

Operator runbook: [setup.md](./setup.md).

## Why Render

The Kamal/DigitalOcean design was complete and workable, but three of the risks it
recorded against itself are solved outright by Render, and Lavela already runs
`lavela-health`, `phi-service` and their databases there:

| Kamal risk | On Render |
|---|---|
| "A containerized Postgres with no backup is a real exposure"; backups out of scope | Managed Postgres with backups |
| Port 22 open to the internet, because GitHub runners have no fixed egress IPs | No servers, no SSH |
| Staging listed as out of scope | Same prod/staging pattern already used by `lavela-health` |

Cost is roughly $80/month against ~$28 for a single droplet. The difference buys managed
backups, one ops model and no server administration.

## Decisions

| Question | Decision |
|---|---|
| Image builds | Unchanged: GitHub Actions builds amd64 images from this repo and pushes to GHCR |
| Render build | **Not used.** Services run `runtime: image` and pull from GHCR |
| Routing | Web owns the domain; Next.js rewrites `/api/v2/*` to the private API service |
| API exposure | `type: pserv` — private, reachable only from `cal-web` |
| Deploy trigger | **Manual** (`workflow_dispatch`) → build → Render API deploy, SHA-pinned |
| Region | `ohio`, matching the rest of the platform |

### Why we do not let Render build

Upstream's own Render blueprint (`calcom/docker`) sidesteps building entirely — its
`Dockerfile.render` is one line, `FROM calcom.docker.scarf.sh/calcom/cal.com`, pulling a
prebuilt public image. That is useless for a fork, but the instinct is right: this
repo's web build needs a 6144 MB heap and the API build 8192 MB, and Render does not
publish build machine specs.

Building in GitHub Actions keeps the build on hardware we control and on a pipeline that
already worked. Render only ever pulls a finished image, so build capacity is not a
deployment risk. **The images are built from this repository** — the fork, with its
branding and Lavela-specific changes. Nothing upstream is deployed.

### Why routing changed

Render attaches a custom domain to a single service and has no path-based router, so the
API cannot claim `/api/v2` at the edge the way kamal-proxy did. This is exactly the
fallback documented in [kamal-deployment/design.md §7](../kamal-deployment/design.md#7-open-risk-requiring-live-verification):
web takes all traffic and the existing rewrite at `apps/web/next.config.ts:371` forwards
`/api/v2/:path*` to `NEXT_PUBLIC_API_V2_URL`.

Two consequences, both improvements over the droplet plan:

- `NEXT_PUBLIC_API_V2_URL` flips from unset to `http://cal-api:10000/api/v2`. It is read
  by `next.config.ts` at server start, not baked into the bundle, so it is a plain
  runtime variable.
- The Let's Encrypt contention risk disappears — only one service holds the domain, and
  Render manages the certificate.

`API_URL` still carries the `/api` prefix, so OAuth redirect URIs are unchanged from the
Kamal design and resolve on the public host.

### Deploys are manual

`deploy.yml` runs on `workflow_dispatch` only; there is no `push` trigger. Merging to
`main` builds nothing and deploys nothing.

Releasing to production is an explicit act. An automatic trigger would build two
multi-GB images and push to a live Render service as a side effect of merging an
unrelated change, with nobody watching. The cost is remembering to run it; the benefit
is that no merge can surprise production.

This can be revisited once the deployment has some history behind it — the workflow is
otherwise ready for a `push: branches: [main]` trigger to be added back.

### Immutable deploys

`render.yaml` carries a floating `:main` tag as a bootstrap value. Each CI deploy
overrides it through the Render API with `ghcr.io/...:<commit-sha>`, so what runs is
always traceable to a commit and a rollback is a redeploy of an older SHA.

A blueprint sync would reset the service to `:main`. That only happens when `render.yaml`
itself changes, and `:main` always points at the latest `main` build, so the drift is
bounded and self-correcting.

## Repository changes

Carried over unchanged from the Kamal work, both platform-independent:

- `Dockerfile` — the 13 missing `NEXT_PUBLIC_*` build args. Render would not have fixed
  this; without them the bundle ships upstream Cal.com branding.
- `apps/api/v2/src/app.module.ts` — never append `?tls=true` to `REDIS_URL`. This is
  **load-bearing on Render**: Render Key Value hands out a plain `redis://` URL, so the
  unpatched code would break the Bull connection in production.

New:

- `render.yaml`
- `.github/scripts/render-deploy.sh`
- `.github/workflows/deploy.yml` — build jobs unchanged, deploy job retargeted

## The Kamal implementation was not committed

`config/deploy*.yml`, `.kamal/secrets` and the droplet runbook were written before the
platform decision changed, and were never validated against a real droplet. They are
deliberately left out of version control rather than carried as a fallback: unused
deployment config that nobody exercises goes stale silently, and the next reader would
reasonably trust it.

[../kamal-deployment/design.md](../kamal-deployment/design.md) is retained, marked
superseded. It holds the analysis that still matters — environment variable bucketing,
the variables that abort API v2 boot, the `API_URL` / OAuth redirect URI reasoning, and
the routing fallback that Render adopts as its primary shape.

## Email is disabled, not deferred

This instance sends no email. The platform owns patient and therapist communication, so
booking mail from Cal would be duplicate and off-brand.

Rather than leave SMTP unconfigured — which falls back to `/usr/sbin/sendmail`, absent
from the `node:20` image, and fails per-send with ENOENT — this uses Cal's built-in kill
switch. `emails` is a `KILL_SWITCH` feature flag whose polarity is inverted relative to
the other flags: **enabled = true prevents sending**. Migration
`20260907000000_enable_emails_kill_switch` sets it.

`BaseEmail.sendEmail()` consults the flag before constructing a transport, so all 25
templated email types short-circuit cleanly. Note that a failing send would not have
broken bookings either — the send is fire-and-forget with a `.catch` that only logs — but
the kill switch makes the intent explicit and keeps the logs clean.

`sendVerificationRequest.ts` builds its own transport and bypasses the flag; it backs
magic-link sign-in and the Stripe payment callback, neither of which is used here. The
practical consequence is that magic-link email sign-in does not work on this deployment,
which is consistent with the platform owning authentication.

`TASKER_ENABLE_EMAILS`, present in `.env.example`, is read by no code in this fork. It
was deliberately not carried into the blueprint.

## Out of scope

Database seeding, monitoring and alerting, a staging environment (the blueprint defines
production only; add staging services mirroring `lavela-health`'s pattern once
production is stable).
