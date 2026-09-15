# Next Available Slots Future Work

Ideas and enhancements deferred from initial implementation.

## Enhancements

- **Filter the aggregate by provider subset.** A `userIds` query parameter so a caller can
  ask for the soonest slots among providers matching its own criteria (state licensure,
  specialty, insurance) rather than the whole client.
- **Grouped output.** An `X slots per provider, grouped` response mode for rendering a full
  availability board in one call. The current semantics are X soonest overall.
- **Cursor pagination.** "The next N after this slot", for infinite-scrolling a soonest-
  availability list.

## Technical Debt

- **Precomputed next-availability index.** The synchronous fan-out is sized for tens of
  providers. At thousands it will not hold, and the answer is a background-maintained
  index invalidated on booking, schedule and OOO changes.
- **A real slots cache.** `DEFAULT_SLOTS_CACHE_TTL` is 2 seconds (`util.ts:79`), which is
  a thundering-herd guard rather than a cache. A longer TTL with explicit invalidation
  would benefit every slots consumer, not just this feature.

## Nice to Have

- Surface *why* a provider has no upcoming availability (no bookable event type, booked
  solid, on OOO) instead of an em dash in the availability grid.
