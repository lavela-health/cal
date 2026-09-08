# Lavela Health — the only consumer of this instance

**Read this before changing anything in API v2, the managed-user path, webhooks, event
types, schedules, or the `/video` route.** This fork is not a general-purpose Cal
deployment. It exists to serve scheduling and video calls to one external application,
and that application depends on specific response shapes, payload fields and URL formats
that are not covered by this repo's own tests.

Everything below was verified against `lavela-health/lavela-health` at `../lavela`. Line
references are to that repo unless the path starts with `apps/` or `packages/`.

**Last verified:** 2026-09-04, against `origin/main` @ `2118f8ed`.

> **This doc is part of the change, not a write-up of it.** Update it in the same PR as
> any change to what it describes — §11 especially. It is the only record of these
> couplings, none of which are covered by tests here, so a stale section is worse than a
> missing one: the next agent will trust it. §3 already documents a case where the
> consumer's own doc drifted from its code; this one is no less prone to it. When you
> re-verify against `../lavela`, move the date above.

## 1. The consumer

`lavela-health/lavela-health` is a Rails monorepo with two apps. Only
`apps/lavela-health` talks to Cal; `apps/phi-service` holds protected health information
and never does.

| Where | What |
|---|---|
| `app/lib/cal/client.rb` | The entire HTTP surface. 17 methods, one per endpoint |
| `app/lib/cal/config.rb`, `instance.rb` | Host and credential resolution per environment |
| `app/services/cal/` | Onboarding, bookings, webhooks, tokens, OOO — plus `self_hosted/` and `tasks/` |
| `app/models/cal/booking.rb` | Server-side booking creation (admin/demo paths) |
| `app/javascript/controllers/*_controller.tsx` | The two `@calcom/atoms` mounts |
| `.claude/docs/calcom.md` | Their own integration doc — useful, but see §3 |

Two PRs brought this instance into play, both **merged to `main` on 2026-09-04**:
**#870** (`29b53eab`) makes the Cal host per-environment behind a `:self_hosted_cal`
Flipper flag; **#871** (`6a4f00c6`) migrates providers, availability and future bookings
onto this instance before that flag is flipped. Two Codex-review commits landed inside
them and matter here: `d51ef1a1` moved host resolution from global to **per account**
(`external_account.metadata['instance']`), and `6a4f00c6` made each provider's migration
cut over in a single transaction.

The flag itself is a separate, later decision — merged does not mean live.

## 2. Who is a user here

**Providers (therapists) are platform-managed users.** Created through
`POST /v2/oauth-clients/{clientId}/users`, stored in Lavela's `external_accounts` table
alongside their OAuth tokens. One row per provider, unique on
`(provider_profile_id, name)`.

**Clients (patients) are never Cal users.** They exist only as attendees on a booking —
name, email, timezone, language. They have no account, no login, and never see a Cal
page except the video room.

This is why the managed-user endpoint is the only path that ever needs to create a `User`
row on this instance. See `specs/platform-only-mode/design.md`.

## 3. Provider lifecycle

`Cal::OnboardProvider` (`app/services/cal/onboard_provider.rb`) runs four steps:

1. `CreateManagedUser` → `POST /v2/oauth-clients/{clientId}/users`
2. Persist `ExternalAccount` with tokens and `metadata: { username, instance }`
3. `CreateDefaultEventType` → `POST /v2/event-types`
4. `DemoAppointment.create_for_provider` — a real booking for testing

If step 2 fails, step 1 is rolled back with `DELETE /v2/oauth-clients/{id}/users/{userId}`.
If step 3 fails, onboarding still succeeds with `event_type_id: nil` — a provider can
exist without an event type, and `Cal::Tasks::EventTypeBackfiller` repairs it later.

**Disconnect leaks.** `Provider::CalController#disconnect` destroys the local
`ExternalAccount` row but never deletes the managed user on Cal. Orphaned managed users
accumulate on this instance. A later reconnect recovers them — see §7.

### The default event type

Created by `Cal::CreateDefaultEventType` with values that are hard-coded constants on
the Rails side. Changing how this instance interprets any of them changes provider
behaviour silently:

| Field | Value |
|---|---|
| `title` / `slug` | `Lavela Therapy` / `lavela-therapy` |
| `lengthInMinutes` | 50 |
| `slotInterval` | 60 |
| `minimumBookingNotice` | 1440 (24h) |
| `disableGuests` | true |
| `confirmationPolicy` | `{ type: "always" }` |
| `calVideoSettings` | recording and transcription disabled for both parties, plus `redirectUrlOnExit` |

`confirmationPolicy: always` is load-bearing: every booking lands **pending** and is
confirmed by Lavela only after payment is secured. Bookings do not self-confirm.

> Their doc calls this event type "Therapy Session". The code says `Lavela Therapy`
> (`app/services/cal/create_default_event_type.rb:10`). Trust the code.

## 4. The booking lifecycle

Bookings are created **in the browser first**, by the `Booker` atom talking directly to
this instance's API v2. Lavela's server never sees the booking until the browser posts
the resulting UID back to it.

```
Booker atom ──POST /v2/bookings──> this instance          (status: pending)
     │
     └──POST {bookingUrl} {uid, id}──> Lavela
                                          │
                    Bookings::Create ──GET /v2/bookings/{uid}──> this instance
                                          │  (fetch, not create)
                                          ├─ reject if provider is out of office
                                          │     └─ POST /v2/bookings/{uid}/cancel
                                          ├─ AppointmentSource{external_id: uid,
                                          │                    external_url: video_url}
                                          └─ Appointment{status: pending}
                                                    │
                              payment secured ──> ConfirmExternalBookingJob
                                                    └─POST /v2/bookings/{uid}/confirm
```

Three things to note:

- **`Bookings::Create` fetches, it does not create.** It calls `GET /v2/bookings/{uid}`
  and reads `data.start`, `data.end`, `data.uid`. The server-side `POST /v2/bookings`
  path (`app/models/cal/booking.rb`) is used only for admin booking-on-behalf, demo
  appointments, and the #871 migration.
- **`confirm` is addressed by UID, not numeric id.** `Cal::Client#confirm_booking` takes
  `booking_id:` but every caller passes `appointment_source.external_id`, which is the
  UID.
- **The meeting URL is constructed by Lavela, not read from the API.**
  `Cal::Instance#video_url` builds `"#{web_url}/video/#{uid}"` by hand. It is written
  once into `appointment_source.external_url` at booking time and never refreshed.

## 5. Webhooks — inbound only

This instance pushes to `Webhooks::CalController#receive`. Lavela never registers
webhooks via API; they are configured by hand at
`/settings/platform/oauth-clients/[clientId]/edit/webhooks`, which makes that dashboard
route operationally load-bearing.

Signature: `X-Cal-Signature-256`, HMAC-SHA256 hex digest over the raw body, validated
against **either** instance's secret (`Cal::WebhookSignatureValidator`) so both Cal
instances can be live at once. Must be exactly 64 hex characters.

Three `triggerEvent` values are handled; everything else is logged and 200'd. The
payload fields Lavela reads, all under `payload.*`:

| Event | Fields read |
|---|---|
| `BOOKING_CREATED` | `uid`, `startTime`, `endTime`, `organizer.id`, `attendees[0].email` |
| `BOOKING_RESCHEDULED` | `uid`, `rescheduleUid`, `startTime`, `endTime` |
| `BOOKING_CANCELLED` | `uid`, `cancellationReason` |

Two of these deserve emphasis:

- **`organizer.id` is how a booking finds its provider.**
  `ExternalAccount.find_by!(name: :cal, external_id: organizer_id)` — the Cal user ID.
  On failure it falls back to `ProviderProfile.first`, which is a dev convenience that
  would silently misattribute a booking in production.
- **`attendees[0].email` is how a booking finds its patient.** Same fallback shape
  (`ClientProfile.first`). Attendee ordering matters.

`BOOKING_RESCHEDULED` looks up the appointment by `rescheduleUid` **or** `uid` so a
redelivered webhook is idempotent, then overwrites `external_id` with the new `uid`.

## 6. Availability and out-of-office

Providers manage availability through the `AvailabilitySettings` atom, which writes
directly to this instance. Lavela keeps **no local mirror** of weekly availability — this
is why #871 has to replay schedules during migration.

Out-of-office is **not** an OOO API call. `Cal::BlockOutOfOffice` reads the provider's
default schedule (`isDefault: true`), merges all-day overrides
(`{ date, startTime: "00:00", endTime: "00:00" }`) into the existing `overrides` array,
and writes the whole array back with `PATCH /v2/schedules/{id}`. `UnblockOutOfOffice`
removes them the same way. The `ooo` module in API v2 is unused and has no controller.

## 7. Tokens

Managed-user access tokens live 60 minutes. Expiry timestamps arrive as **millisecond
epochs** and are divided by 1000 on the Rails side — `accessTokenExpiresAt`,
`refreshTokenExpiresAt`.

Three refresh paths:

| Path | Trigger |
|---|---|
| `POST /v2/oauth/{clientId}/refresh` | Normal refresh, 5-minute expiry buffer, before most calls |
| `POST /v2/oauth-clients/{id}/users/{userId}/force-refresh` | Fallback when refresh returns 400/401 |
| `Cal::RefreshTokensJob` | Hourly sweep, 30-minute buffer |

The browser gets its own path: `CalProvider` is given `refreshUrl: "/api/v1/cal/refresh"`,
a Lavela endpoint that looks the account up by `access_token_fingerprint`
(SHA256 of the bearer token) and returns a fresh `accessToken`.

**409 responses are load-bearing.** `CreateManagedUser` treats 409 as "already exists",
then recovers via `GET /v2/oauth-clients/{id}/users?email=` followed by force-refresh.
`CreateDefaultEventType` treats 409 as success. Both make onboarding and the #871
migration re-runnable after partial failure. Do not change these to 200-with-body or to
a different status.

## 8. What the browser needs

Lavela mounts two atoms components at eight points across seven views:

- `Booker` (6) — `bookings/new`, `provider/bookings/new`, `appointment_reschedules/reschedule`,
  `admin/member_bookings/new`, `admin/member_reschedules/new`, `admin/providers_availability/show`
- `AvailabilitySettings` (2) — `provider/availabilities/_availability_form`,
  `admin/providers_availability/show`

Both `apiUrl` and `clientId` are resolved per account (`cal_account.cal_instance`) since
`d51ef1a1`, not from a global config.

**The Booker addresses a provider by Cal username plus event slug**, not by ID. The
username comes from `external_account.metadata['username']`, cached at onboarding from
the managed-user creation response. It resolves through
`GET /v2/atoms/event-types/{eventSlug}/public?username=...`, which is **unauthenticated**
(`apps/api/v2/src/modules/atoms/controllers/atoms.event-types.controller.ts:55`).

That username is generated by *this* instance, not chosen by Lavela —
`createNewUsersConnectToOrgIfExists.ts:74` slugifies `{emailUser}-{domainName}-{TLD}`
for platform-managed users. Changing that generation breaks every cached username, which
is why `Cal::Tasks::UsernameBackfiller` exists.

The atoms also reach endpoints the Rails client never touches. `BookerPlatformWrapper.tsx:37-38`
imports `useConnectedCalendars` and `useCalendarsBusyTimes`, so the Booker calls
`/v2/calendars` and `/v2/calendars/busy-times`. **Any audit of "which API v2 modules are
unused" that reads only `Cal::Client` will be wrong.**

## 9. The video room

Both patients and providers leave Lavela for this instance to attend a session:

- `app/controllers/appointment_starts_controller.rb:19`
- `app/controllers/provider/waiting_rooms_controller.rb:37`

Both do `redirect_to external_url, allow_other_host: true`, where `external_url` is the
`"{web_url}/video/{uid}"` string stored at booking time. On exit, `redirectUrlOnExit`
sends the browser back to Lavela's `/session/complete`, which routes by role.

**This is why the web app cannot be reduced to an API-only deployment**, and why commit
`4f381e2e28` had to teach `redirectUrlOnExit` to accept localhost URLs.

Admins also open `{web_url}/bookings/upcoming` from Lavela's admin home, which requires a
real password login on this instance.

## 10. API surface consumed

Server-side, from `Cal::Client`. Version headers are pinned per resource — the
`2024-04-15` variants are not used.

| Endpoint | Methods | `cal-api-version` |
|---|---|---|
| `/oauth-clients/{clientId}/users` | POST, GET | — |
| `/oauth-clients/{clientId}/users/{userId}` | GET, DELETE | — |
| `/oauth-clients/{clientId}/users/{userId}/force-refresh` | POST | — |
| `/oauth/{clientId}/refresh` | POST | — |
| `/event-types`, `/event-types/{id}` | POST, GET, PATCH | `2024-06-14` |
| `/bookings`, `/bookings/{uid}`, `/bookings/{uid}/confirm`, `/bookings/{uid}/cancel` | POST, GET | `2024-08-13` |
| `/slots` | GET | `2024-09-04` |
| `/schedules`, `/schedules/{id}` | GET, POST, PATCH | `2024-06-11` |

Response shapes Lavela parses positionally:

- Managed user create → `data.user.id`, `data.user.username`, `data.accessToken`,
  `data.refreshToken`, `data.accessTokenExpiresAt`, `data.refreshTokenExpiresAt`
- Booking get → `data.uid`, `data.start`, `data.end`
- Booking confirm → `data.meetingUrl`
- Event type create → `data.id`
- Schedules list → array with `isDefault`, `id`, `timeZone`, `overrides`
- Slots → `data` is an **object keyed by date**, each value an array of slots with `start`
- Errors → `error.message`

## 11. Invariants

Breaking any of these breaks Lavela without breaking a test in this repo.

1. `/video/{uid}` must stay served by the web app, and `calVideoSettings.redirectUrlOnExit`
   must keep redirecting on exit.
2. `GET /v2/atoms/event-types/{slug}/public?username=` must stay unauthenticated and must
   keep resolving platform-managed users by username.
3. Platform-managed username generation must stay stable. Lavela caches it.
4. Webhook payloads must keep `organizer.id` and `attendees[0].email`, and `triggerEvent`
   must keep its three current values.
5. `X-Cal-Signature-256` must stay HMAC-SHA256 hex over the raw body.
6. Token expiry timestamps must stay millisecond epochs.
7. 409 must remain the duplicate response for managed users and event types.
8. `minimumBookingNotice` is enforced on event-type create. #871 works around it by
   creating with 0 and restoring 1440 afterwards.
9. `POST /v2/bookings/{uid}/confirm` must keep accepting a UID in the id position.
10. `/slots` must keep returning an object keyed by date, not a flat array.
11. Schedule `overrides` must keep accepting `00:00`–`00:00` as an all-day block.

## 12. Deployment coupling

- **Both instances run at once during migration.** `external_account.metadata['instance']`
  routes per provider, so providers move one at a time while the rest stay on Cal.com.
  This instance holds production data before `:self_hosted_cal` is flipped.
- **Staging and production both point at `cal.lavelahealth.com`** — per PR #870's
  description; the values live in encrypted credentials and cannot be verified from
  source. Separated only by OAuth client. Managed-user emails are namespaced `user+{clientId}@domain`
  (`oauth-clients-users.service.ts:155`) so user rows will not collide — but the database,
  the `daily-video` app key and the admin accounts are shared.
- **Cal Video requires `DAILY_API_KEY` at seed time.** `getDailyAppKeys.ts` reads only
  from the `App` table with no env fallback, so a missing key surfaces as a Zod parse
  failure when someone starts a session, not at boot.

## Related

- `specs/platform-only-mode/design.md` — reducing this instance to the surface above
- `specs/kamal-deployment/design.md` — how it is deployed
- `../lavela/.claude/docs/calcom.md` — the consumer's own view of the same integration
