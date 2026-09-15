# Next Available Slots Implementation

## Status: not-started

## Completed

## In Progress

## Blocked

## Next Steps

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

## Session Notes
