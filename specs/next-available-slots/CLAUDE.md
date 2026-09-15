# CLAUDE.md — Next Available Slots

## Project Context

Two new API v2 endpoints returning the soonest N bookable slots as a flat, time-ordered
list — one for a single provider, one aggregated across every managed user of a Platform
OAuth client. The same engine feeds a "Next available" column on the web app's per-client
availability grid.

## Before Starting Work

1. Read specs/next-available-slots/design.md
2. Check specs/next-available-slots/implementation.md for current progress
3. Look at existing patterns in:
   - packages/trpc/server/routers/viewer/slots/util.ts (AvailableSlotsService, the cache wrapper)
   - apps/api/v2/src/modules/slots/slots-2024-09-04/ (controller, input/output services)
   - apps/api/v2/src/modules/oauth-clients/controllers/oauth-client-users/ (guard pairing)

## Code Patterns

- The engine is a plain class in packages/trpc/server/routers/viewer/slots/nextSlots.ts,
  taking AvailableSlotsService as a constructor dependency. API v2 reaches it through
  packages/platform/libraries/slots.ts, which already re-exports AvailableSlotsService.
- API v2 controllers import their contracts from @calcom/platform-types, never from
  @calcom/features or @calcom/trpc directly.
- Swagger decorators follow the house style in slots.controller.ts:60.

## Don't

- Don't add features not in design.md
- Don't skip tests
- Don't touch GET /v2/slots. Invariant #10 pins its date-keyed response shape.
- Don't let the OAuth client secret reach the browser — the availability column goes
  through tRPC, not through the aggregate endpoint.
- Don't put the engine in packages/features. Rule #8 forbids it importing @calcom/trpc.
