# Next Available Slots Decisions

## ADR-001: New routes rather than a `limit` parameter on `/v2/slots`

### Context

`GET /v2/slots` already computes availability. Adding `limit` to it would have been the
smallest diff.

### Options Considered

1. Add `limit` + optional `end` to `/v2/slots` — smallest diff, but the response is an
   object keyed by date, so "the 5 soonest" cannot be expressed without either reshaping
   the response or making the caller re-sort a nested structure.
2. New sibling routes returning a flat array — more surface, unambiguous shape.

### Decision

New routes. Invariant #10 in `agents/lavela-health-integration.md` pins the date-keyed
shape of `/v2/slots`, and Lavela parses it positionally. A flat, time-ordered array is
also the only shape that can carry the owning provider per slot, which the aggregate
route needs.

### Consequences

- `/v2/slots` is untouched; no risk to the existing booking flow.
- Two response shapes now coexist for slots. A new invariant (#13) records that this is
  deliberate, so a later change does not unify them.

## ADR-002: Windowed expansion with a global early exit

### Context

"The next N slots" has no natural date range. A fixed 90-day search would be correct but
would pay for 90 days of computation on every call, and slot computation is expensive —
`withSlotsCache` has a 2-second TTL (`util.ts:79`), so there is no real cache to lean on.

### Options Considered

1. Fixed horizon — simple, uniformly expensive.
2. Per-candidate incremental expansion — cheapest per candidate, but a candidate that
   expands further than another can be compared only after both settle; ordering logic
   gets fiddly.
3. Global windowed expansion — query all candidates over the same window, widen only if
   the whole batch came up short.

### Decision

Option 3, over `[7d, 30d, 90d]` clamped by `maxHorizonDays`.

### Consequences

- Correct by construction: everything outside the window is strictly later than
  everything inside it, so a full window is provably the global answer.
- The common case costs one narrow window.
- Expansion re-queries rather than accumulating, because rolling-window period types and
  booking limits are evaluated against the whole range — `[now, now+30d]` is not
  `[now, now+7d]` plus the remainder. Duplicated work on the uncommon path is the price
  of not returning wrong slots for limited event types.

## ADR-003: The availability column goes through tRPC, not the aggregate endpoint

### Context

The web app's per-client availability grid needs the same data the aggregate endpoint
returns.

### Options Considered

1. Call `/v2/oauth-clients/{clientId}/slots/next` from the browser — reuses the endpoint,
   but requires the OAuth client secret client-side.
2. Widen `viewer.availability.listTeam` to include the next slot — one query, but every
   grid paint waits on slot computation.
3. A separate tRPC procedure over the same engine.

### Decision

Option 3.

### Consequences

- The client secret never reaches the browser.
- The existing grid keeps its current first-paint latency; the new column loads
  independently with its own state.
- The grid's existing pagination (10 rows) bounds the fan-out for free.
