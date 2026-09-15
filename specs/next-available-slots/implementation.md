# Next Available Slots Implementation

## Status: complete

## Completed

1. `NextSlotsService` in `packages/trpc/server/routers/viewer/slots/nextSlots.ts` —
   windowed expansion, bounded concurrency, `getNextSlots` + `getNextSlotPerCandidate`
2. Unit tests against a stubbed `AvailableSlotsService` (see design.md § Testing)
3. Re-export from `packages/platform/libraries/slots.ts`
4. Platform types: `get-next-slots.input.ts`, `get-next-slots.output.ts`, barrel updates
5. API v2 `NextSlotsService_2024_09_04` + `GET /v2/slots/next` on the existing controller
6. API v2 `GET /v2/oauth-clients/{clientId}/slots/next` — new controller, candidate
   resolution, module wiring
7. Swagger decorators on both routes
8. tRPC procedure under `viewer.availability` for the web app
9. "Next available" column in `AvailabilitySliderTable` + `common.json` string
10. `agents/lavela-health-integration.md` — §10 table, §11 new invariant
11. `yarn type-check:ci --force`, `yarn biome check --write .`, `TZ=UTC yarn test`

## In Progress

## Blocked

## Next Steps

None. Open the draft PR.

## Session Notes

- The engine's own tests caught a real defect during Task 1: a widening pass overwrote the
  slots the previous window had found, so a candidate whose calendar timed out on the
  second pass would erase results already collected. The engine now keeps the best result
  seen rather than the last.
- `ownedEventTypes` (the `userId` owner relation), not `eventTypes` (the `user_eventtype`
  many-to-many), is what links a managed user to their bookable event types. Verified
  against the local database: the Development client's managed user owns `lavela-therapy`
  at 50 minutes through `EventType.userId`.
- Not verified: the availability column in a browser, and neither endpoint against a
  running server — the sandbox blocks a process from binding a port. Both endpoints pass
  type check and the Nest build, and the engine is unit tested.
- Two tests fail in `packages/app-store/googlecalendar/lib/__tests__/CalendarService.test.ts`.
  They fail identically on `main` (from `3343aca19f`) and are unrelated to this branch.
