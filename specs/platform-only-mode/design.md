# Platform-only mode

**Status:** Design proposed, not implemented
**Date:** 2026-09-04

## Goal

Reduce this instance to the surface that Lavela Health actually consumes, and make that
reduction structural rather than configurational. Today the fork ships the full Cal
product — public booking pages, self-serve signup, an app store, 37 API v2 controllers —
while its only consumer is one Rails app talking to a fixed set of endpoints on behalf of
managed users it provisions itself.

Two things motivate this beyond tidiness. First, `cal.lavelahealth.com` will hold
attendee names, emails and dated therapy appointments; every reachable surface that
nothing uses is exposure without benefit. Second, during the migration window described
in [§7](#7-constraints-inherited-from-the-migration-design) both Cal instances are live
simultaneously, so this host is publicly reachable and holding real data while the
consumer-side feature flag is still off.

## Decisions

| Question              | Decision                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Enforcement mechanism | A `PLATFORM_ONLY` env var read at request time, checked at three chokepoints, not env-var-only configuration           |
| Web app exposure      | Public, but reduced to four route families. It cannot be withheld — see [§3.3](#33-web-routes)                         |
| API v2 reduction      | Trim `EndpointsModule` / `PlatformEndpointsModule`, but only after empirical verification. See [§6](#6-api-v2-surface) |
| Signup                | Closed in code, including the `token` bypass. The existing `disable-signup` flag remains as a runtime override         |
| Conferencing          | Cal Video only, enforced by seeding one `App` row. No code change                                                      |
| Operator bootstrap    | `/api/auth/setup` stays open as the last-resort path; the platform owner is seeded at deploy time. [§4.4](#44-operating-it-once-the-door-is-closed) |
| Delivery              | Five sequential PRs, [§8](#8-pr-split)                                                                                 |

Rejected alternatives are recorded in [Appendix A](#appendix-a--rejected-alternatives).
Questions the operator still has to answer are in [Appendix B](#appendix-b--open-questions).

## 1. The consumer

The only consumer is `lavela-health/lavela-health`, specifically `apps/lavela-health`.
Its integration is documented in that repo at `.claude/docs/calcom.md` and implemented
across `app/lib/cal/` and `app/services/cal/`. Two PRs define the target state, both
**merged to `main` on 2026-09-04**:

- **#870** (`29b53eab`) — `Cal::Config` resolves the Cal host per environment from
  encrypted credentials, gated on the `:self_hosted_cal` Flipper flag
- **#871** (`6a4f00c6`) — `Cal::SelfHosted::MigrateProvider` moves providers,
  availability and future bookings across before the flag is flipped

Merged is not live: the flag flip is a separate, later decision. See
[agents/lavela-health-integration.md](../../agents/lavela-health-integration.md) for the
full contract.

Providers are Cal **managed users**, created through the platform OAuth client and
tracked in Lavela's `external_accounts` table. Clients are never Cal users at all — they
are attendees on a booking. This matters: the managed-user path is the only path that
ever needs to create a `User` row on this instance.

## 2. What "platform-only" means here

Three independent reductions, in descending order of confidence:

1. **User creation** — one door (the OAuth client), closed structurally rather than by
   configuration
2. **Web surface** — four reachable route families out of the full product
3. **API v2 surface** — a subset of modules, derived empirically rather than by
   inspection

They are independent and can ship separately.

## 3. The contract

This is what Lavela actually calls. Everything else is a candidate for removal.

### 3.1 Server → API v2 (`Cal::Client`)

Traced from `apps/lavela-health/app/lib/cal/client.rb`. Version headers are pinned per
resource and matter — the `2024-04-15` variants are not used.

| Endpoint                                                 | Method      | `cal-api-version` |
| -------------------------------------------------------- | ----------- | ----------------- |
| `/oauth-clients/{clientId}/users`                        | POST, GET   | —                 |
| `/oauth-clients/{clientId}/users/{userId}`               | GET, DELETE | —                 |
| `/oauth-clients/{clientId}/users/{userId}/force-refresh` | POST        | —                 |
| `/oauth/{clientId}/refresh`                              | POST        | —                 |
| `/event-types`                                           | POST, GET   | `2024-06-14`      |
| `/event-types/{id}`                                      | PATCH       | `2024-06-14`      |
| `/bookings`                                              | POST        | `2024-08-13`      |
| `/bookings/{id}/confirm`                                 | POST        | `2024-08-13`      |
| `/bookings/{uid}`                                        | GET         | `2024-08-13`      |
| `/bookings/{uid}/cancel`                                 | POST        | `2024-08-13`      |
| `/slots`                                                 | GET         | `2024-09-04`      |
| `/schedules`                                             | GET, POST   | `2024-06-11`      |
| `/schedules/{id}`                                        | PATCH       | `2024-06-11`      |

Two absences worth recording, because both look like gaps and are not:

- **Out-of-office is not an API surface.** `Cal::BlockOutOfOffice` and
  `Cal::UnblockOutOfOffice` implement it as schedule date overrides through
  `PATCH /schedules/{id}`. The fork's `ooo` module has no controller regardless.
- **Webhooks are never registered via API.** `Cal::Client` has no webhook method;
  registration happens by hand in the platform dashboard at
  `/settings/platform/oauth-clients/[clientId]/edit/webhooks`. That route is therefore
  load-bearing, not decoration.

### 3.2 Browser → API v2 (`@calcom/atoms`)

Lavela mounts exactly two atoms components, both wrapped in `CalProvider` with
`apiUrl` set to `browser_api_url`:

- `Booker` — `app/javascript/controllers/booking_calendar_controller.tsx`
- `AvailabilitySettings` — `app/javascript/controllers/availability_manager_controller.tsx`

**These pull in more API surface than the Rails client does, and the difference is not
obvious from the component names.** `BookerPlatformWrapper.tsx:37-38` imports
`useConnectedCalendars` and `useCalendarsBusyTimes`, which call `/v2/calendars` and
`/v2/calendars/busy-times`. Nothing in `Cal::Client` touches calendars, so a cut list
derived from the Rails side alone would have removed `CalendarsModule` and broken the
Booker's busy-time overlay.

`AvailabilitySettings` calls the `/v2/atoms/schedules/*` family, which is distinct from
the `/v2/schedules` family the Rails client uses. Both are required.

This is the reason [§6](#6-api-v2-surface) requires measurement.

### 3.3 Web routes

Lavela links out to this instance in exactly two places, plus the two it needs for
itself:

| Route                  | Reached from                                                                     | Notes                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `/video/{uid}`         | `appointment_starts_controller.rb:19`, `provider/waiting_rooms_controller.rb:37` | Both `redirect_to external_url, allow_other_host: true`. Members and providers both leave Lavela for this page |
| `/bookings/upcoming`   | `Admin::HomesHelper#admin_external_tool_links`                                   | Admin-facing. Requires a real password login on this instance                                                  |
| `/auth/login`          | —                                                                                | Required by the above                                                                                          |
| `/settings/platform/*` | —                                                                                | OAuth client and webhook administration                                                                        |

**The web app cannot be withheld from the public internet.** The video room is served
by Next.js at `apps/web/app/(use-page-wrapper)/video/[uid]/page.tsx`, and every event
type Lavela creates carries `calVideoSettings.redirectUrlOnExit` pointing back at
Lavela's `cal_session_complete_url` (`Cal::Client.video_settings`). That round trip is
the session-completion flow. This is also why commit `4f381e2e28` had to teach
`redirectUrlOnExit` to accept localhost URLs.

Everything else in the web app is unreachable by design: booking happens through atoms
inside Lavela, so `(booking-page-wrapper)/[user]/[type]` serves nobody.

## 4. User creation

### 4.1 Current paths

Every non-test caller that creates a `User` row:

| #   | Path                                                                      | Gate today                                                                   | Target                       |
| --- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------- |
| 1   | `POST /v2/oauth-clients/{id}/users` → `oauth-clients-users.service.ts:28` | Client id + secret headers; rejects clients with no `organizationId` (`:40`) | **Keep** — the only door     |
| 2   | `POST /api/auth/signup` → `selfHostedHandler.ts`                          | `NEXT_PUBLIC_DISABLE_SIGNUP` or the `disable-signup` flag                    | Close in code                |
| 3   | `POST /api/auth/setup` (`route.ts:29`)                                    | Self-closing once `user.count() != 0`                                        | **Leave open** — last-resort bootstrap, see [§4.4](#44-operating-it-once-the-door-is-closed) |
| 4   | NextAuth SSO auto-provision (`next-auth-options.ts:1112`)                 | Only live if provider env vars are set                                       | Close in code                |
| 5   | NextAuth adapter `createUser` (`next-auth-custom-adapter.ts:66`)          | Same as #4                                                                   | Covered by #4's chokepoint   |
| 6   | tRPC `viewer.admin.users.add`                                             | `authedAdminProcedure`, role `ADMIN`                                         | Leave; it is the break-glass |

Much of the hard work is already done and was not done here: the Cal.diy refactor
removed the EE org/teams layer, so there is **no teams router in tRPC** and the
`organizations`, `teams` and `memberships` modules in API v2 ship **zero controllers**.
The team-invite user-creation path that would normally be the messiest thing to close
is already unreachable.

### 4.2 The signup bypass

`apps/web/app/api/auth/signup/route.ts:25-26` returns early — skipping
`ensureSignupIsEnabled` entirely — when the request body carries a `token`:

```ts
// Still allow signups if there is a team invite
if (token) return;
```

With the teams router gone there is no UI that mints those `VerificationToken` rows, so
this is not currently exploitable. But the bypass is unconditional in code, and the only
thing standing between it and a live signup endpoint is "no one can create the token."
That is a configuration argument on a host that will hold patient appointment data.

### 4.3 `PLATFORM_ONLY`

A single env var, read through a small `lib` helper so it is greppable, checked at three
places:

1. **`apps/web/app/api/auth/signup/route.ts`** — reject before the `token` early-return,
   so the bypass closes with it. This subsumes `NEXT_PUBLIC_DISABLE_SIGNUP`; that var
   and the `disable-signup` flag stay in place as the runtime override.
2. **`packages/features/auth/lib/next-auth-options.ts`, `signIn` callback (`:788`)** —
   refuse sign-in for any account that does not already exist, which closes #4 and #5
   together. The adapter's `createUser` is only reached through this callback.
3. **A Nest guard registered as `APP_GUARD` in `apps/api/v2/src/app.module.ts`** —
   alongside the existing `CustomThrottlerGuard` at `:81`. Defence in depth for whatever
   controllers survive [§6](#6-api-v2-surface); it should _not_ be the mechanism by which
   modules are removed.

The value is read at request time, not at boot, so it can be flipped without a rebuild.
Default it to off so local development and CI are unaffected.

**`/api/auth/setup` is deliberately not a fourth chokepoint.** It already self-closes at
`user.count() != 0`, and it is the only bootstrap that needs neither an existing admin
nor shell access. Gating it would remove the last way to recover a database that has
been emptied or restored without users. See [§4.4](#44-operating-it-once-the-door-is-closed).

### 4.4 Operating it once the door is closed

Closing signup is only half a decision; the other half is how a human operator is
created afterwards. Provider accounts are unaffected — they come through the OAuth
client, which stays open by design — so this section is only about the account that
manages OAuth clients, registers webhooks and opens `/bookings/upcoming`.

Four paths exist, and only one of them produces a working platform dashboard user:

| Path                             | Needs                | Produces                                      |
| -------------------------------- | -------------------- | --------------------------------------------- |
| `POST /api/auth/setup`           | an empty `User` table | An `ADMIN`, no platform Profile               |
| `/settings/admin/users/add`      | an existing `ADMIN`  | A bare `User`, no password, no platform Profile |
| `scripts/seed-platform.ts`       | shell on the container | User + org + Membership + **Profile**         |
| Direct SQL                       | database access      | whatever you write                            |

Three findings shape the recommendation:

**The admin UI creates a user that cannot open `/settings/platform`.**
`platformMe.handler.ts:15-22` resolves the organization through **Profile** rows, and
`useGetUserAttributes.ts:15` gates the dashboard on `organization.isPlatform`. The tRPC
`users.add` mutation is a bare `prisma.user.create` (`_router.ts:65`) and writes no
Profile, so the account it produces can reach `/settings/admin` but not the platform
dashboard. `seed-platform.ts` is the only thing in the repo that writes that Profile,
and it carries a comment saying exactly this. There is no impersonation provider in this
fork to work around it — the `impersonatedBy` reference in
`video/[uid]/getServerSideProps.ts:212` is residual typing, not a live feature.

**A password can be set without deliverable email.** `userBodySchema` has no password
field, so admin-created users start with no `Password` row. That is recoverable:
`reset-password` upserts rather than updates (`route.ts:72-75`), and the reset link is
`{WEBAPP_URL}/auth/forgot-password/{ResetPasswordRequest.id}` (`passwordResetRequest.ts:33`)
— the path segment is the row id, so it can be read straight out of Postgres and handed
over. Useful before SMTP is configured.

**The global `emails` flag is a lockout risk.** `ForgotPasswordEmail extends BaseEmail`,
so password resets route through the kill switch at `_base-email.ts:34`. Enabling that
flag with signup closed and no usable admin locks the web UI to shell access only. This
is an independent reason to use the per-OAuth-client `areEmailsEnabled` for suppressing
booking email rather than the global flag: `areEmailsEnabled` reaches only the booking
paths via `noEmail` and leaves auth email alone.

Consequences for delivery:

1. **Create the platform owner at deploy time, not after.** The Kamal design lists
   initial data as a tracked follow-up; this promotes it to a prerequisite, and requires
   `scripts/seed-platform.ts` to ship inside the image.
2. **Keep at least two `ADMIN` accounts**, so losing one does not mean SSH.
3. **Add a `seed-platform-operator` script** that attaches Profile + Membership to an
   existing email. This is the operation the admin UI cannot perform, it is a gap
   independent of this spec, and it is roughly thirty lines reusing what
   `seed-platform.ts` already does.

## 5. Web surface

There is **no `middleware.ts` anywhere in this repo** — Next.js middleware is unused.
Adding `apps/web/middleware.ts` with an allow-list matcher for the four route families
in [§3.3](#33-web-routes) is therefore a single new file with no existing behaviour to
preserve, and nothing upstream to conflict with on rebase.

Allow: `/video/*`, `/bookings*`, `/auth/*`, `/settings/platform/*`, `/api/*`, plus
Next's own `/_next/*` and static assets. Deny everything else with a 404 rather than a
redirect, so the instance does not advertise what it is hiding.

Deliberately not doing this by deleting route groups — see
[Appendix A](#appendix-a--rejected-alternatives).

## 6. API v2 surface

Roughly half the 37 controllers appear unused. The confident candidates are the
`2024-04-15` variants of event-types, schedules, slots and bookings (Lavela pins later
versions on every call), plus `api-keys`, `vercel-webhook` and `event-types-private-links`.

**Do not derive the rest of the cut list by inspection.** [§3.2](#32-browser--api-v2-calcomatoms)
is a worked example of why: the Booker's calendar hooks make `CalendarsModule` load-bearing
in a way that reading `Cal::Client` would never reveal, and the atoms bundle also
references `/stripe/check`, `/stripe/connect` and `/atoms/verification/*` from components
Lavela does not obviously mount.

The method instead:

1. Ship [§4](#4-user-creation) and [§5](#5-web-surface) first
2. Run the staging migration from PR #871 end to end with proxy access logging on
3. Exercise every Lavela flow that touches Cal — provider onboarding, availability edit,
   OOO block and unblock, booking, confirm, reschedule, cancel, token refresh, and a real
   session through the video room
4. Take the observed path set as the floor, add the confident candidates as the ceiling,
   and remove modules from `EndpointsModule` / `PlatformEndpointsModule` between them

Removing a module from the imports array is a two-file diff that deletes no code, so it
rebases cleanly and reverts trivially.

## 7. Constraints inherited from the migration design

Three properties of PRs #870/#871 constrain what this spec may assume:

- **Both instances are live at once.** `external_account.metadata['instance']` routes
  per provider, and `Cal::WebhookSignatureValidator` accepts a payload signed by either
  instance's secret. Providers migrate one at a time. This instance is therefore
  publicly reachable and holding production data well before `:self_hosted_cal` flips.
- **Staging and production share this instance.** Per #870, development points at a
  local Cal while _staging and production both point at `cal.lavelahealth.com`_,
  separated only by OAuth client. Managed-user emails are namespaced
  `user+{clientId}@domain` (`oauth-clients-users.service.ts:155`) so user rows will not
  collide — but the Postgres database, the `App.keys` row for `daily-video`, the admin
  accounts and the Daily.co account are all shared. Staging bookings would create real
  Daily rooms on the production key. See [Appendix B](#appendix-b--open-questions).
- **Existing rows keep their old host.** `appointment_source.external_url` is written
  once at booking time, so nothing here can retroactively affect sessions already booked
  against Cal.com.

## 8. PR split

Per the repo's 500-line / 10-file limit, five sequential PRs:

| PR  | Scope                                                                                     | Rough size            |
| --- | ----------------------------------------------------------------------------------------- | --------------------- |
| 0   | `seed-platform-operator` script ([§4.4](#44-operating-it-once-the-door-is-closed))         | ~1 file               |
| 1   | `PLATFORM_ONLY` helper + the three chokepoints + specs                                    | ~6 files              |
| 2   | `apps/web/middleware.ts` allow-list + specs                                               | ~2 files              |
| 3   | Conferencing lockdown — seed only `daily-video`, document the `DAILY_API_KEY` requirement | ~2 files, mostly docs |
| 4   | API v2 module trim, **after** the §6 measurement                                          | ~2 files              |

PR 4 is gated on staging evidence and should not be opened before it exists.

## 9. Conferencing

No code change required. `App.enabled` defaults to `false` and `_appRegistry.ts:42`
filters on it, but the operative gate is narrower than that: `getVideoAdapters.ts:14`
resolves adapters from `Credential` rows, not from `App.enabled`. So "Cal Video only"
follows from creating exactly one conferencing credential.

`scripts/seed-app-store.ts:148` creates the `daily-video` app only when `DAILY_API_KEY`
is present, writing it into `App.keys`. There is **no env fallback** —
`getDailyAppKeys.ts` reads exclusively from the `App` table via `getAppKeysFromSlug`, so
a missing seed produces a Zod parse failure at meeting-creation time rather than a clear
startup error. Worth asserting in the deploy checklist.

The other 20+ video adapters in `packages/app-store/` stay dark as long as no credential
exists for them.

## 10. Out of scope

- **Cleaning up Cal.com.** #871 deliberately leaves bookings on the hosted instance so
  it stays a complete record. Providers will see duplicate sessions until that is
  handled separately.
- **The `legacy_cal` snapshot lifecycle.** Lives in the Lavela repo.
- **Database backups.** Already flagged as out of scope in the Kamal design and still
  outstanding.
- **Rate limiting.** `EndpointsModule.configure` still carries a `TODO: apply ratelimits`.
  Real, but orthogonal.
- **Audit logging.** See [Appendix B](#appendix-b--open-questions).

## Appendix A — rejected alternatives

**Expose only API v2 through kamal-proxy, drop the web container.** Considered first and
killed by [§3.3](#33-web-routes): the video room and the `redirectUrlOnExit` round trip
are the session-completion flow, and `/bookings/upcoming` is a live admin link. The web
app is not optional.

**Configuration only — env vars and the `disable-signup` flag, no code.** Free and
reversible, and genuinely sufficient in a lower-stakes deployment. Rejected because it
leaves the `token` bypass at `route.ts:25-26` open, and because one mis-set env var on one
redeploy re-opens public signup on a host holding patient data. The three-file diff buys
a property that cannot be undone by a deploy mistake.

**Delete route groups from `apps/web/app/`.** Removes the most surface, but this fork
already carries the cost of restoring things a previous refactor deleted — `12eb84f437`
and `6d05a3790f` exist precisely because `ab21c7f80` and `9cd1f34f1` cut too deep. A
middleware allow-list achieves the same reachability outcome and survives rebases.

**Derive the API v2 cut list by reading `Cal::Client`.** Would have removed
`CalendarsModule`, which `BookerPlatformWrapper.tsx:420` needs. Rejected in favour of
measurement.

## Appendix B — open questions

1. **Is staging sharing production's Cal instance intentional?** Per #870 both point at
   `cal.lavelahealth.com`. Managed users will not collide, but the database, the Daily
   account and the admin logins are shared, and staging bookings would create real Daily
   rooms billed to production. If unintentional, the cheapest fix is a second droplet or
   a `cal-staging.` host; if intentional, it belongs in the deploy checklist explicitly.
2. **Who administers this instance, and how many accounts?** [§4.4](#44-operating-it-once-the-door-is-closed)
   establishes that adding a platform operator is not a UI operation and needs a script.
   What remains open is a decision, not a mechanism: how many `ADMIN` accounts exist, who
   holds them, and whether a second one is provisioned at deploy time or only when the
   first is lost.
3. **Is Cal in scope for the PHI posture?** The rest of the monorepo isolates PHI in
   `phi-service` with append-only audit logging. Cal will hold attendee names, emails and
   dated therapy appointments outside that boundary. This spec does not change the
   answer, but it raises the cost of getting [§4](#4-user-creation) wrong, and the
   decision should be recorded somewhere rather than arrived at by default.
4. **Does the admin `/bookings/upcoming` link justify keeping a password-login surface?**
   If Lavela's own admin views could show the same data, `/auth/*` could close too and
   the web app would reduce to `/video/*` plus the platform dashboard.
