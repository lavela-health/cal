# Next Available Slots Design

## Overview

Two new API v2 endpoints that answer "when is the next opening?" without the caller
guessing a date window: one for a single provider, one aggregated across every managed
user of a Platform OAuth client. Both return a flat, time-ordered list of the soonest N
slots. The same engine also powers a "Next available" column on the web app's per-client
availability grid.

## Problem Statement

`GET /v2/slots` is window-based and single-event-type: it requires `start` **and** `end`,
returns an object keyed by date, and has no notion of "the next N". Lavela Health wants
two things that this shape cannot express:

1. **The upcoming X available slots across the whole OAuth client** — "what are the
   earliest appointments bookable with anyone at Lavela?"
2. **The next X slots for a given provider.**

Emulating either on top of `/v2/slots` means guessing a horizon (how far do you look when
a therapist is booked solid for six weeks?), issuing one HTTP round trip per provider from
Rails, and re-implementing the same expansion logic in every consumer that wants it.

Nothing resembling this exists in the repo today. `onlyShowFirstAvailableSlot`
(`packages/trpc/server/routers/viewer/slots/util.ts:1278`) is an event-type flag that
trims each *day* to its first slot — it hides the 2nd..Nth slot of a day, which is the
opposite of what is needed here.

### Two facts from the existing code that shape the design

**Slot computation is barely cached.** `AvailableSlotsService.getAvailableSlots` is
wrapped in `withSlotsCache` (`util.ts:104`), keyed on `JSON.stringify(input)`, with
`DEFAULT_SLOTS_CACHE_TTL = 2000`ms (`util.ts:79`, overridable via `SLOTS_CACHE_TTL`). That
is a thundering-herd guard, not a cache. Every fan-out element is a real computation
touching schedules, bookings, booking limits, OOO and busy times — and, where a provider
has an external calendar connected, potentially an outbound API call. Cost control is the
central concern of this design, not an afterthought.

**`minimumBookingNotice` is already honoured.** `getStartTime` (`util.ts:672`) shifts the
search start by the event type's notice, so Lavela's 1440-minute (24h) default falls out
for free. "Next available" will never return a slot inside the notice window, and this
design adds nothing to make that true.

## User Stories

- As Lavela Health, I want the X soonest slots across all my providers in one call, so
  that I can show a patient the earliest appointments available anywhere in the practice.
- As Lavela Health, I want the next X slots for one provider, so that I can show
  "soonest availability" on a provider's profile without guessing a date range.
- As a Lavela operator using the Cal admin UI, I want to see each provider's next opening
  in the per-client availability grid, so that I can spot providers with no upcoming
  availability.

## Technical Design

### Database Changes

None. No schema change, no migration.

### Where the engine lives

The engine depends on `AvailableSlotsService`, which lives in
`packages/trpc/server/routers/viewer/slots/util.ts`. Rule #8 in
`agents/rules/architecture-circular-dependencies.md` forbids `packages/features` from
importing `@calcom/trpc`, so the engine cannot live in `packages/features`.

It goes in **`packages/trpc/server/routers/viewer/slots/nextSlots.ts`** as a plain class
`NextSlotsService`, beside `AvailableSlotsService`, taking it as a constructor dependency.
Two consumers reach it:

- **API v2** re-exports it through `packages/platform/libraries/slots.ts` — the same file
  that already re-exports `AvailableSlotsService` (line 3) for exactly this reason.
- **The web app** calls it directly from a tRPC procedure.

One implementation, two consumers, no layering violation.

### The algorithm

```ts
getNextSlots({
  candidates,        // Array<{ eventTypeId: number }> — resolved by the caller
  limit,
  after,             // defaults to now
  maxHorizonDays,    // defaults to 90
  timeZone,
  duration,
}): Promise<NextSlot[]>   // flat, sorted by start ascending, length <= limit
```

Windowed expansion with a global early exit, over windows `[7d, 30d, 90d]` clamped by
`maxHorizonDays`:

1. For every candidate event type, call `AvailableSlotsService.getAvailableSlots` over
   `[after, after + window]`, with bounded concurrency (default 8 in flight).
2. Flatten, sort by `start`, take `limit`.
3. If that yields exactly `limit` slots, **stop**.
4. Otherwise widen to the next window and repeat, re-querying all candidates.
5. Return whatever the final window produced.

**Why the early exit is correct, not an approximation:** every slot not examined lies
outside `[after, after + window]`, i.e. strictly later than every slot inside it. So if the
window already yields `limit` slots, the `limit` soonest among them are the `limit` soonest
overall. The common case — a client with open availability — pays one narrow window.

**Why windows are day-aligned:** the `withSlotsCache` key is the serialised input. Snapping
window bounds to day boundaries means repeated calls within the TTL hit the cache instead
of missing on a drifting timestamp.

**Why step 4 re-queries rather than accumulating:** slot computation for `[now, now+30d]`
is not `[now, now+7d]` plus `[now+7d, now+30d]` — rolling-window period types and booking
limits are evaluated against the whole range. Re-querying keeps the engine honest about
the event type's own rules. Expansion is the uncommon path, so the duplicated work is
acceptable; the alternative silently produces wrong slots for limited event types.

A second entry point serves the availability grid:

```ts
getNextSlotPerCandidate({ candidates, ... }): Promise<Map<eventTypeId, NextSlot | null>>
```

Same engine, `limit: 1` per candidate rather than globally, no cross-candidate early exit.

### Candidate resolution

Deliberately the caller's job, so the engine stays dumb and testable.

For the aggregate endpoint: managed users of the client (via the `platformOAuthClients`
relation, as `findManagedUsersByOAuthClientIdAndEmails` in
`apps/api/v2/src/modules/users/users.repository.ts:216` already does) → each user's
`getUserEventTypesPublic` (`event-types.repository.ts:129`, so `hidden: false` only) →
**every** event type they own. Users with no bookable event type are skipped, not errors:
a provider can legitimately exist without one (`Cal::CreateDefaultEventType` may have
failed and `Cal::Tasks::EventTypeBackfiller` not yet run — see
`agents/lavela-health-integration.md` §3).

### API Changes

| Route | Auth | Version |
|---|---|---|
| `GET /v2/slots/next` | `OptionalApiAuthGuard` | `2024-09-04` |
| `GET /v2/oauth-clients/{clientId}/slots/next` | `ApiAuthGuard` + `OAuthClientGuard` (`x-cal-secret-key`) | `API_VERSIONS_VALUES` |

`/v2/slots/next` does not collide with the existing routes in `slots.controller.ts`
(`/`, `/reservations`, `/reservations/:uid`).

**Query parameters**

| Param | Routes | Notes |
|---|---|---|
| `limit` | both | required, 1..50 |
| `after` | both | ISO 8601 UTC, defaults to now |
| `timeZone` | both | defaults to UTC, as `/v2/slots` |
| `maxHorizonDays` | both | 1..365, defaults to 90 |
| `eventTypeId` \| (`username` + `eventTypeSlug`) | `/v2/slots/next` | one form required |
| `duration` | `/v2/slots/next` | multiple-duration event types |
| `eventTypeSlug` | aggregate | optional filter, narrows each provider's event types |

**Response.** Both return the standard `{ status, data }` envelope with `data` as a flat,
time-ordered array — **never** the date-keyed object:

```json
{
  "status": "success",
  "data": [
    {
      "start": "2026-09-12T14:00:00.000Z",
      "end": "2026-09-12T14:50:00.000Z",
      "duration": 50,
      "eventTypeId": 42,
      "eventTypeSlug": "lavela-therapy",
      "user": { "id": 7, "username": "amy-farrah-fowler-abc123", "name": "Amy Fowler" }
    }
  ]
}
```

`user` appears only on the aggregate route. `eventTypeId` and `duration` are on every slot
because the aggregate searches *all* of a provider's event types, so the merged list can
mix durations — the consumer needs them to tell a 50-minute therapy slot from anything
else.

A response shorter than `limit` means the horizon was exhausted. It is not an error and
carries no separate flag; `maxHorizonDays` is the documented bound.

**These are new routes, not a change to `/v2/slots`.** Invariant #10 in
`agents/lavela-health-integration.md` pins the date-keyed shape of `/v2/slots`, and this
design leaves that endpoint completely untouched.

**New DTOs** in `packages/platform/types/slots/slots-2024-09-04/`
(`inputs/get-next-slots.input.ts`, `outputs/get-next-slots.output.ts`, plus barrel
updates), since API v2 controllers import their contracts from `@calcom/platform-types`.

**tRPC**: one new procedure under `viewer.availability` taking `userIds[]` and returning
the next slot per user, for the web app only.

### UI Changes

**OpenAPI / Swagger.** Both controllers carry full `@ApiOperation`, `@ApiQuery` and
`@DocsResponse` decorators in the style of `slots.controller.ts:60`, so the routes land in
the generated API v2 reference.

**Availability page.** `AvailabilitySliderTable`
(`apps/web/modules/timezone-buddy/components/AvailabilitySliderTable.tsx`) gains a
**"Next available"** column showing each managed user's soonest opening, or an em dash
when there is none within the horizon.

It cannot call the aggregate endpoint: that requires the OAuth client secret, which must
never reach the browser. So the column is fed by the new tRPC procedure over the same
`NextSlotsService`.

It is a **separate query from `listTeam`**, not a widening of it, for two reasons: the
existing grid keeps its current first-paint latency, and the new column gets its own
loading state. The grid already paginates at 10, so the fan-out is bounded by page size
without any extra machinery.

New string in `packages/i18n/locales/en/common.json`.

## Edge Cases

| Case | Behaviour |
|---|---|
| Provider has no bookable event type | Skipped. Not an error — see §3 of the integration doc. |
| Provider is booked solid past `maxHorizonDays` | Contributes nothing; list is short, no error. |
| Client has zero managed users | Empty array, `200`. |
| `after` is in the past | Clamped to now. |
| `after` is inside `minimumBookingNotice` | Handled by `getStartTime`; no slot inside the notice is ever returned. |
| Event type has `ROLLING` / `ROLLING_WINDOW` period type | Its own cap applies and may be tighter than `maxHorizonDays`. Not overridden. |
| Multiple providers free at the same instant | Both returned; ties broken by `eventTypeId` for a stable order across calls. |
| Mixed durations in the aggregate list | Expected. Each slot carries `duration` and `eventTypeId`. |
| A single provider's slot computation throws | Logged and that provider is dropped, rather than failing the whole aggregate. |

## Testing

Unit tests on `NextSlotsService` against a stubbed `AvailableSlotsService` — that is where
the real logic is, and stubbing keeps the tests free of the slot engine's dependency tree:

- Early exit fires when the first window satisfies `limit` (assert no second round).
- Expansion widens when the first window comes up short.
- Global ordering is correct across candidates, not just within one.
- Horizon exhaustion returns a short list rather than throwing.
- The concurrency cap is respected (assert max in-flight).
- A throwing candidate is dropped without failing the batch.
- Tie-breaking is stable.

## Contract documentation

`agents/lavela-health-integration.md` is updated **in this PR**:

- §10 gains both routes in the consumed-API table.
- §11 gains an invariant: *the next-slots routes return a flat, time-ordered array, not a
  date-keyed object* — the deliberate mirror of #10, so a later change cannot "helpfully"
  unify the two shapes.

## Out of Scope

- **Precomputation or a long-lived cache.** At tens of providers a synchronous fan-out is
  fine. A background "next available" index, invalidated on booking/schedule/OOO changes,
  is the answer at thousands — see `future-work.md`.
- **Filtering by provider attributes** (licensure, specialty, insurance). The aggregate
  route covers the whole client; a caller-supplied `userIds` filter is a later addition.
- **Reshaping or deprecating `/v2/slots`.** Untouched.
- **Slot reservation.** `POST /v2/slots/reservations` already exists and is unchanged.
- **Grouped-by-provider output.** The chosen semantics are X soonest overall.

## PR size

This exceeds the repo's stated budget (<500 lines, <10 code files) — roughly 13-14 code
files across the engine, platform types, two controllers, a tRPC procedure and the
availability table. It ships as one PR by explicit request. The natural split, if it is
ever wanted, is: (1) engine + `/v2/slots/next`, (2) aggregate route, (3) availability
column.
