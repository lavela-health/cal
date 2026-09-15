# Next Available Slots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two API v2 endpoints that return the soonest N bookable slots as a flat, time-ordered array — one for a single provider, one aggregated across every managed user of a Platform OAuth client — plus a "Next available" column on the web app's per-client availability grid.

**Architecture:** A dependency-light engine class, `NextSlotsService`, lives beside `AvailableSlotsService` in `packages/trpc/server/routers/viewer/slots/`. It performs windowed expansion with a global early exit over a caller-supplied list of candidate event types, calling `AvailableSlotsService.getAvailableSlots` with bounded concurrency. API v2 reaches it through `packages/platform/libraries/slots.ts`; the web app reaches it through a new tRPC procedure. Candidate resolution stays outside the engine so it remains pure and testable.

**Tech Stack:** TypeScript (strict), NestJS (API v2), tRPC, Prisma, Vitest, `class-validator`/`@nestjs/swagger` for API v2 DTOs, React + TanStack Table for the web grid.

**Spec:** `specs/next-available-slots/design.md`

## Global Constraints

- **Never touch `GET /v2/slots`.** Invariant #10 of `agents/lavela-health-integration.md` pins its date-keyed response shape, and Lavela parses it positionally.
- **The engine must not live in `packages/features`.** Rule #8 of `agents/rules/architecture-circular-dependencies.md` forbids `packages/features` from importing `@calcom/trpc`, and the engine depends on `AvailableSlotsService` from `packages/trpc`.
- **The OAuth client secret must never reach the browser.** The availability column goes through tRPC, never through `/v2/oauth-clients/{clientId}/slots/next`.
- **Prisma queries use `select`, never `include`.**
- **No `as any`.**
- API v2 controllers import contracts from `@calcom/platform-types`, never from `@calcom/features` or `@calcom/trpc` directly.
- Defaults, copied verbatim from the design: windows `[7, 30, 90]` days; `maxHorizonDays` default `90`, range `1..365`; `limit` range `1..50`; concurrency default `8`; `timeZone` defaults to UTC.
- All UI strings go in `packages/i18n/locales/en/common.json` and are rendered through `t()`.
- Conventional commits. Run `yarn biome check --write .` before each commit.

---

### Task 1: The `NextSlotsService` engine

This is the whole feature's logic. Everything after this task is wiring.

**Files:**
- Create: `packages/trpc/server/routers/viewer/slots/nextSlots.ts`
- Test: `packages/trpc/server/routers/viewer/slots/nextSlots.test.ts`

**Interfaces:**
- Consumes: `IGetAvailableSlots` from `@calcom/features/bookings/Booker/hooks/useAvailableTimeSlots` (shape: `{ slots: Record<string, { time: string; away?: boolean; ... }[]> }`), and `GetScheduleOptions` from `./types`.
- Produces, relied on by every later task:
  - `NextSlotCandidate = { eventTypeId: number; eventTypeSlug: string; duration: number; user?: NextSlotUser }`
  - `NextSlotUser = { id: number; username: string | null; name: string | null }`
  - `NextSlot = { start: string; end: string; duration: number; eventTypeId: number; eventTypeSlug: string; user?: NextSlotUser }`
  - `ISlotsProvider = { getAvailableSlots(args: GetScheduleOptions): Promise<IGetAvailableSlots> }`
  - `class NextSlotsService { constructor(slotsProvider: ISlotsProvider, concurrency?: number); getNextSlots(params: GetNextSlotsParams): Promise<NextSlot[]>; getNextSlotPerCandidate(params: GetNextSlotPerCandidateParams): Promise<Map<number, NextSlot | null>> }`
  - `GetNextSlotsParams = { candidates: NextSlotCandidate[]; limit: number; after?: Date; maxHorizonDays?: number; timeZone?: string }`
  - `GetNextSlotPerCandidateParams = Omit<GetNextSlotsParams, "limit">`
  - Constants `NEXT_SLOTS_WINDOWS_DAYS`, `NEXT_SLOTS_DEFAULT_MAX_HORIZON_DAYS`, `NEXT_SLOTS_DEFAULT_CONCURRENCY`

- [ ] **Step 1: Write the failing test file**

Create `packages/trpc/server/routers/viewer/slots/nextSlots.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GetScheduleOptions } from "./types";
import {
  NEXT_SLOTS_DEFAULT_MAX_HORIZON_DAYS,
  NextSlotsService,
  type ISlotsProvider,
  type NextSlotCandidate,
} from "./nextSlots";

const AFTER = new Date("2026-09-10T08:00:00.000Z");

// The service clamps a past `after` to now, so every fixed-date assertion below needs the
// clock pinned to AFTER rather than to whenever the suite happens to run.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AFTER);
});

afterEach(() => {
  vi.useRealTimers();
});

function candidate(eventTypeId: number, overrides: Partial<NextSlotCandidate> = {}): NextSlotCandidate {
  return {
    eventTypeId,
    eventTypeSlug: `event-${eventTypeId}`,
    duration: 50,
    ...overrides,
  };
}

/**
 * Returns slots per event type, per call index, so a test can say "this event type has
 * nothing in the first window and something in the second".
 */
function stubProvider(byEventType: Record<number, string[][]>) {
  const callsPerEventType = new Map<number, number>();
  const windows: { eventTypeId: number; startTime: string; endTime: string }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const provider: ISlotsProvider = {
    async getAvailableSlots({ input }: GetScheduleOptions) {
      const eventTypeId = input.eventTypeId as number;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      windows.push({ eventTypeId, startTime: input.startTime, endTime: input.endTime });
      await Promise.resolve();
      const round = callsPerEventType.get(eventTypeId) ?? 0;
      callsPerEventType.set(eventTypeId, round + 1);
      const times = byEventType[eventTypeId]?.[round] ?? [];
      inFlight -= 1;
      return {
        slots: times.reduce<Record<string, { time: string }[]>>((acc, time) => {
          const day = time.slice(0, 10);
          acc[day] = [...(acc[day] ?? []), { time }];
          return acc;
        }, {}),
      };
    },
  };

  return { provider, windows, getMaxInFlight: () => maxInFlight };
}

describe("NextSlotsService", () => {
  it("returns the globally soonest slots across candidates, sorted by start", async () => {
    const { provider } = stubProvider({
      1: [["2026-09-12T15:00:00.000Z", "2026-09-12T17:00:00.000Z"]],
      2: [["2026-09-12T14:00:00.000Z", "2026-09-12T16:00:00.000Z"]],
    });
    const service = new NextSlotsService(provider);

    const slots = await service.getNextSlots({
      candidates: [candidate(1), candidate(2)],
      limit: 3,
      after: AFTER,
    });

    expect(slots.map((slot) => slot.start)).toEqual([
      "2026-09-12T14:00:00.000Z",
      "2026-09-12T15:00:00.000Z",
      "2026-09-12T16:00:00.000Z",
    ]);
    expect(slots[0].eventTypeId).toBe(2);
  });

  it("computes end from the candidate duration", async () => {
    const { provider } = stubProvider({ 1: [["2026-09-12T14:00:00.000Z"]] });
    const service = new NextSlotsService(provider);

    const [slot] = await service.getNextSlots({
      candidates: [candidate(1, { duration: 50 })],
      limit: 1,
      after: AFTER,
    });

    expect(slot.end).toBe("2026-09-12T14:50:00.000Z");
    expect(slot.duration).toBe(50);
  });

  it("stops after the first window once limit is satisfied", async () => {
    const { provider, windows } = stubProvider({
      1: [["2026-09-12T14:00:00.000Z", "2026-09-12T15:00:00.000Z"]],
    });
    const service = new NextSlotsService(provider);

    await service.getNextSlots({ candidates: [candidate(1)], limit: 2, after: AFTER });

    expect(windows).toHaveLength(1);
  });

  it("widens the window when the first one comes up short", async () => {
    const { provider, windows } = stubProvider({
      1: [[], ["2026-09-25T09:00:00.000Z"]],
    });
    const service = new NextSlotsService(provider);

    const slots = await service.getNextSlots({ candidates: [candidate(1)], limit: 1, after: AFTER });

    expect(windows).toHaveLength(2);
    expect(windows[1].endTime > windows[0].endTime).toBe(true);
    expect(slots.map((slot) => slot.start)).toEqual(["2026-09-25T09:00:00.000Z"]);
  });

  it("returns a short list rather than throwing when the horizon is exhausted", async () => {
    const { provider } = stubProvider({ 1: [[], [], []] });
    const service = new NextSlotsService(provider);

    const slots = await service.getNextSlots({ candidates: [candidate(1)], limit: 5, after: AFTER });

    expect(slots).toEqual([]);
  });

  it("clamps an `after` in the past to now, so the window is not spent on dead days", async () => {
    const { provider, windows } = stubProvider({ 1: [[]] });
    const service = new NextSlotsService(provider);

    await service.getNextSlots({
      candidates: [candidate(1)],
      limit: 1,
      after: new Date("2020-01-01T00:00:00.000Z"),
      maxHorizonDays: 7,
    });

    // Identical to the window an `after` of now would have produced, not a 2020 one.
    expect(windows[0].startTime).toBe("2026-09-10T00:00:00.000Z");
    expect(windows[0].endTime).toBe("2026-09-17T23:59:59.999Z");
  });

  it("never returns a slot at or before `after`", async () => {
    const { provider } = stubProvider({
      1: [["2026-09-10T07:00:00.000Z", "2026-09-10T09:00:00.000Z"]],
    });
    const service = new NextSlotsService(provider);

    const slots = await service.getNextSlots({ candidates: [candidate(1)], limit: 5, after: AFTER });

    expect(slots.map((slot) => slot.start)).toEqual(["2026-09-10T09:00:00.000Z"]);
  });

  it("queries day-aligned windows so the slots cache key is stable", async () => {
    const { provider, windows } = stubProvider({ 1: [["2026-09-12T14:00:00.000Z"]] });
    const service = new NextSlotsService(provider);

    await service.getNextSlots({ candidates: [candidate(1)], limit: 1, after: AFTER });

    expect(windows[0].startTime).toBe("2026-09-10T00:00:00.000Z");
    expect(windows[0].endTime).toBe("2026-09-17T23:59:59.999Z");
  });

  it("drops the away slots the booker hides", async () => {
    const provider: ISlotsProvider = {
      async getAvailableSlots() {
        return {
          slots: {
            "2026-09-12": [
              { time: "2026-09-12T14:00:00.000Z", away: true },
              { time: "2026-09-12T15:00:00.000Z" },
            ],
          },
        };
      },
    };
    const service = new NextSlotsService(provider);

    const slots = await service.getNextSlots({ candidates: [candidate(1)], limit: 5, after: AFTER });

    expect(slots.map((slot) => slot.start)).toEqual(["2026-09-12T15:00:00.000Z"]);
  });

  it("breaks ties on eventTypeId so ordering is stable across calls", async () => {
    const { provider } = stubProvider({
      7: [["2026-09-12T14:00:00.000Z"]],
      3: [["2026-09-12T14:00:00.000Z"]],
    });
    const service = new NextSlotsService(provider);

    const slots = await service.getNextSlots({
      candidates: [candidate(7), candidate(3)],
      limit: 2,
      after: AFTER,
    });

    expect(slots.map((slot) => slot.eventTypeId)).toEqual([3, 7]);
  });

  it("drops a candidate that throws instead of failing the batch", async () => {
    const provider: ISlotsProvider = {
      async getAvailableSlots({ input }: GetScheduleOptions) {
        if (input.eventTypeId === 1) throw new Error("calendar unreachable");
        return { slots: { "2026-09-12": [{ time: "2026-09-12T14:00:00.000Z" }] } };
      },
    };
    const service = new NextSlotsService(provider);

    const slots = await service.getNextSlots({
      candidates: [candidate(1), candidate(2)],
      limit: 5,
      after: AFTER,
    });

    expect(slots.map((slot) => slot.eventTypeId)).toEqual([2]);
  });

  it("honours the concurrency cap", async () => {
    const { provider, getMaxInFlight } = stubProvider(
      Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [index + 1, [["2026-09-12T14:00:00.000Z"]]])
      )
    );
    const service = new NextSlotsService(provider, 3);

    await service.getNextSlots({
      candidates: Array.from({ length: 10 }, (_, index) => candidate(index + 1)),
      limit: 50,
      after: AFTER,
    });

    expect(getMaxInFlight()).toBeLessThanOrEqual(3);
  });

  it("clamps windows to maxHorizonDays", async () => {
    const { provider, windows } = stubProvider({ 1: [[], []] });
    const service = new NextSlotsService(provider);

    await service.getNextSlots({
      candidates: [candidate(1)],
      limit: 1,
      after: AFTER,
      maxHorizonDays: 14,
    });

    expect(windows).toHaveLength(2);
    expect(windows[1].endTime).toBe("2026-09-24T23:59:59.999Z");
  });

  it("defaults maxHorizonDays to the documented constant", async () => {
    expect(NEXT_SLOTS_DEFAULT_MAX_HORIZON_DAYS).toBe(90);
  });

  it("getNextSlotPerCandidate returns one slot per candidate, null when none", async () => {
    const { provider } = stubProvider({
      1: [["2026-09-12T14:00:00.000Z", "2026-09-12T15:00:00.000Z"]],
      2: [[], [], []],
    });
    const service = new NextSlotsService(provider);

    const result = await service.getNextSlotPerCandidate({
      candidates: [candidate(1), candidate(2)],
      after: AFTER,
    });

    expect(result.get(1)?.start).toBe("2026-09-12T14:00:00.000Z");
    expect(result.get(2)).toBeNull();
  });

  it("passes timeZone and duration through to the slots provider", async () => {
    const getAvailableSlots = vi.fn(async () => ({ slots: {} }));
    const service = new NextSlotsService({ getAvailableSlots });

    await service.getNextSlots({
      candidates: [candidate(1, { duration: 25 })],
      limit: 1,
      after: AFTER,
      timeZone: "Europe/Rome",
      maxHorizonDays: 7,
    });

    expect(getAvailableSlots).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ timeZone: "Europe/Rome", duration: 25, eventTypeId: 1 }),
      })
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TZ=UTC yarn vitest run packages/trpc/server/routers/viewer/slots/nextSlots.test.ts`
Expected: FAIL — `Failed to resolve import "./nextSlots"`.

- [ ] **Step 3: Implement the engine**

Create `packages/trpc/server/routers/viewer/slots/nextSlots.ts`:

```ts
import type { IGetAvailableSlots } from "@calcom/features/bookings/Booker/hooks/useAvailableTimeSlots";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import type { GetScheduleOptions } from "./types";

const log = logger.getSubLogger({ prefix: ["[slots/nextSlots]"] });

export const NEXT_SLOTS_WINDOWS_DAYS = [7, 30, 90];
export const NEXT_SLOTS_DEFAULT_MAX_HORIZON_DAYS = 90;
export const NEXT_SLOTS_DEFAULT_CONCURRENCY = 8;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

export type NextSlotUser = {
  id: number;
  username: string | null;
  name: string | null;
};

export type NextSlotCandidate = {
  eventTypeId: number;
  eventTypeSlug: string;
  /** Minutes. The event type's length, or the caller's explicit override. */
  duration: number;
  user?: NextSlotUser;
};

export type NextSlot = {
  start: string;
  end: string;
  duration: number;
  eventTypeId: number;
  eventTypeSlug: string;
  user?: NextSlotUser;
};

export interface ISlotsProvider {
  getAvailableSlots(args: GetScheduleOptions): Promise<IGetAvailableSlots>;
}

export type GetNextSlotsParams = {
  candidates: NextSlotCandidate[];
  limit: number;
  after?: Date;
  maxHorizonDays?: number;
  timeZone?: string;
};

export type GetNextSlotPerCandidateParams = Omit<GetNextSlotsParams, "limit">;

/**
 * The windows to try, in order, clamped to the caller's horizon. The last entry is always
 * exactly `maxHorizonDays` so the final attempt covers the whole permitted range.
 */
export function buildWindows(maxHorizonDays: number): number[] {
  const windows = NEXT_SLOTS_WINDOWS_DAYS.filter((days) => days < maxHorizonDays);
  return [...windows, maxHorizonDays];
}

export class NextSlotsService {
  constructor(
    private readonly slotsProvider: ISlotsProvider,
    private readonly concurrency: number = NEXT_SLOTS_DEFAULT_CONCURRENCY
  ) {}

  /**
   * The `limit` soonest slots across every candidate.
   *
   * Widening stops as soon as a window yields `limit` slots: every slot outside the window
   * starts later than every slot inside it, so a full window is already the global answer.
   */
  async getNextSlots({
    candidates,
    limit,
    after: requestedAfter = new Date(),
    maxHorizonDays = NEXT_SLOTS_DEFAULT_MAX_HORIZON_DAYS,
    timeZone,
  }: GetNextSlotsParams): Promise<NextSlot[]> {
    if (!candidates.length || limit < 1) return [];

    // A caller-supplied `after` in the past would spend the whole first window on days
    // that have already happened, and `getStartTime` clamps the query to now regardless.
    const now = new Date();
    const after = requestedAfter.getTime() < now.getTime() ? now : requestedAfter;

    let found: NextSlot[] = [];
    for (const windowDays of buildWindows(maxHorizonDays)) {
      const batches = await this.mapWithConcurrency(candidates, (candidate) =>
        this.slotsForCandidate({ candidate, after, windowDays, timeZone })
      );
      found = sortSlots(batches.flat()).slice(0, limit);
      if (found.length >= limit) break;
    }
    return found;
  }

  /** The soonest slot for each candidate, or null when the horizon holds none. */
  async getNextSlotPerCandidate({
    candidates,
    after = new Date(),
    maxHorizonDays = NEXT_SLOTS_DEFAULT_MAX_HORIZON_DAYS,
    timeZone,
  }: GetNextSlotPerCandidateParams): Promise<Map<number, NextSlot | null>> {
    const results = await this.mapWithConcurrency(candidates, async (candidate) => {
      const [slot] = await this.getNextSlots({
        candidates: [candidate],
        limit: 1,
        after,
        maxHorizonDays,
        timeZone,
      });
      return [candidate.eventTypeId, slot ?? null] as const;
    });
    return new Map(results);
  }

  private async slotsForCandidate({
    candidate,
    after,
    windowDays,
    timeZone,
  }: {
    candidate: NextSlotCandidate;
    after: Date;
    windowDays: number;
    timeZone?: string;
  }): Promise<NextSlot[]> {
    // Day-aligned bounds keep the `withSlotsCache` key stable across calls made seconds
    // apart; slots before `after` are filtered out below rather than by the query.
    const startOfDay = new Date(Math.floor(after.getTime() / MS_PER_DAY) * MS_PER_DAY);
    const endOfWindow = new Date(startOfDay.getTime() + windowDays * MS_PER_DAY - 1);

    let available: IGetAvailableSlots;
    try {
      available = await this.slotsProvider.getAvailableSlots({
        ctx: {},
        input: {
          eventTypeId: candidate.eventTypeId,
          startTime: startOfDay.toISOString(),
          endTime: endOfWindow.toISOString(),
          duration: candidate.duration,
          timeZone,
          isTeamEvent: false,
          orgSlug: null,
        },
      });
    } catch (error) {
      // One provider's calendar being unreachable must not empty the whole board.
      log.warn(
        "Skipping candidate whose slots could not be computed",
        safeStringify({ eventTypeId: candidate.eventTypeId, error })
      );
      return [];
    }

    return Object.values(available.slots)
      .flat()
      .filter((slot) => !slot.away)
      .map((slot) => toNextSlot(slot.time, candidate))
      .filter((slot) => new Date(slot.start).getTime() > after.getTime());
  }

  private async mapWithConcurrency<TItem, TResult>(
    items: TItem[],
    worker: (item: TItem) => Promise<TResult>
  ): Promise<TResult[]> {
    const results = new Array<TResult>(items.length);
    let cursor = 0;

    const runners = Array.from({ length: Math.min(this.concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index]);
      }
    });

    await Promise.all(runners);
    return results;
  }
}

function toNextSlot(time: string, candidate: NextSlotCandidate): NextSlot {
  const start = new Date(time);
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + candidate.duration * MS_PER_MINUTE).toISOString(),
    duration: candidate.duration,
    eventTypeId: candidate.eventTypeId,
    eventTypeSlug: candidate.eventTypeSlug,
    ...(candidate.user ? { user: candidate.user } : {}),
  };
}

function sortSlots(slots: NextSlot[]): NextSlot[] {
  return [...slots].sort((a, b) => {
    const delta = new Date(a.start).getTime() - new Date(b.start).getTime();
    // Stable across calls: without the tie-break, two providers free at the same instant
    // swap places between requests depending on which fan-out resolved first.
    return delta !== 0 ? delta : a.eventTypeId - b.eventTypeId;
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `TZ=UTC yarn vitest run packages/trpc/server/routers/viewer/slots/nextSlots.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Type check and format**

Run: `yarn biome check --write packages/trpc/server/routers/viewer/slots/` then `yarn type-check:ci --force`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add packages/trpc/server/routers/viewer/slots/nextSlots.ts packages/trpc/server/routers/viewer/slots/nextSlots.test.ts
git commit -m "feat(slots): add NextSlotsService for soonest-N slot queries"
```

---

### Task 2: Export the engine and add the platform-types contracts

**Files:**
- Modify: `packages/platform/libraries/slots.ts`
- Create: `packages/platform/types/slots/slots-2024-09-04/inputs/get-next-slots.input.ts`
- Create: `packages/platform/types/slots/slots-2024-09-04/outputs/next-slots.output.ts`
- Modify: `packages/platform/types/slots/slots-2024-09-04/inputs/index.ts`
- Modify: `packages/platform/types/slots/slots-2024-09-04/outputs/index.ts`

**Interfaces:**
- Consumes: `NextSlotsService`, `NextSlot`, `NextSlotCandidate`, `ISlotsProvider` from Task 1.
- Produces: `GetNextSlotsInput_2024_09_04`, `GetClientNextSlotsInput_2024_09_04`, `NextSlot_2024_09_04`, `NextSlotUser_2024_09_04` — imported by Tasks 3 and 4 from `@calcom/platform-types`.

- [ ] **Step 1: Re-export the engine for API v2**

`packages/platform/libraries/slots.ts` currently re-exports `AvailableSlotsService` from `@calcom/trpc/server/routers/viewer/slots/util`. Append:

```ts
import {
  NextSlotsService,
  NEXT_SLOTS_DEFAULT_MAX_HORIZON_DAYS,
} from "@calcom/trpc/server/routers/viewer/slots/nextSlots";
import type {
  ISlotsProvider,
  NextSlot,
  NextSlotCandidate,
  NextSlotUser,
} from "@calcom/trpc/server/routers/viewer/slots/nextSlots";

export { NextSlotsService, NEXT_SLOTS_DEFAULT_MAX_HORIZON_DAYS };
export type { ISlotsProvider, NextSlot, NextSlotCandidate, NextSlotUser };
```

- [ ] **Step 2: Write the input DTOs**

Create `packages/platform/types/slots/slots-2024-09-04/inputs/get-next-slots.input.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsDateString, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

class NextSlotsBaseInput {
  @ApiProperty({ description: "How many slots to return.", example: 5, minimum: 1, maximum: 50 })
  @Transform(({ value }: { value: string }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  @Max(50)
  limit!: number;

  @ApiPropertyOptional({
    description:
      "Only return slots starting after this time. Must be in UTC timezone as an ISO 8601 datestring. Defaults to now.",
    example: "2050-09-05T09:00:00Z",
  })
  @IsOptional()
  @IsDateString()
  after?: string;

  @ApiPropertyOptional({
    description: "Time zone in which the slots should be returned. Defaults to UTC.",
    example: "Europe/Rome",
  })
  @IsOptional()
  @IsString()
  timeZone?: string;

  @ApiPropertyOptional({
    description:
      "How far into the future to search before giving up. A response shorter than 'limit' means this horizon held no more slots.",
    example: 90,
    minimum: 1,
    maximum: 365,
    default: 90,
  })
  @IsOptional()
  @Transform(({ value }: { value: string }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  @Max(365)
  maxHorizonDays?: number;
}

export class GetNextSlotsInput_2024_09_04 extends NextSlotsBaseInput {
  @ApiPropertyOptional({
    description: "The ID of the event type. Either this, or username plus eventTypeSlug, is required.",
    example: 100,
  })
  @IsOptional()
  @Transform(({ value }: { value: string }) => parseInt(value, 10))
  @IsInt()
  eventTypeId?: number;

  @ApiPropertyOptional({ description: "The username of the event type's owner.", example: "bob" })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional({ description: "The slug of the event type.", example: "intro" })
  @IsOptional()
  @IsString()
  eventTypeSlug?: string;

  @ApiPropertyOptional({
    description: "For event types that allow multiple durations, the desired duration in minutes.",
    example: 60,
  })
  @IsOptional()
  @Transform(({ value }: { value: string }) => parseInt(value, 10))
  @IsInt()
  duration?: number;
}

export class GetClientNextSlotsInput_2024_09_04 extends NextSlotsBaseInput {
  @ApiPropertyOptional({
    description:
      "Restrict the search to each managed user's event type with this slug. Defaults to every bookable event type they own.",
    example: "intro",
  })
  @IsOptional()
  @IsString()
  eventTypeSlug?: string;
}
```

- [ ] **Step 3: Write the output DTOs**

Create `packages/platform/types/slots/slots-2024-09-04/outputs/next-slots.output.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsDateString, IsInt, IsOptional, IsString, ValidateNested } from "class-validator";

export class NextSlotUser_2024_09_04 {
  @ApiProperty({ description: "ID of the user who owns the event type." })
  @IsInt()
  id!: number;

  @ApiProperty({ description: "Username of the user who owns the event type.", nullable: true })
  @IsString()
  username!: string | null;

  @ApiProperty({ description: "Name of the user who owns the event type.", nullable: true })
  @IsString()
  name!: string | null;
}

export class NextSlot_2024_09_04 {
  @ApiProperty({ description: "Start time of the slot." })
  @IsDateString()
  start!: string;

  @ApiProperty({ description: "End time of the slot." })
  @IsDateString()
  end!: string;

  @ApiProperty({ description: "Duration of the slot in minutes." })
  @IsInt()
  duration!: number;

  @ApiProperty({ description: "ID of the event type this slot belongs to." })
  @IsInt()
  eventTypeId!: number;

  @ApiProperty({ description: "Slug of the event type this slot belongs to." })
  @IsString()
  eventTypeSlug!: string;

  @ApiPropertyOptional({
    type: NextSlotUser_2024_09_04,
    description: "The user this slot is bookable with. Only returned by the OAuth client endpoint.",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => NextSlotUser_2024_09_04)
  user?: NextSlotUser_2024_09_04;
}
```

- [ ] **Step 4: Update the barrels**

Append `export * from "./get-next-slots.input";` to `packages/platform/types/slots/slots-2024-09-04/inputs/index.ts` and `export * from "./next-slots.output";` to `packages/platform/types/slots/slots-2024-09-04/outputs/index.ts`.

- [ ] **Step 5: Type check**

Run: `yarn type-check:ci --force`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
yarn biome check --write packages/platform
git add packages/platform/libraries/slots.ts packages/platform/types/slots
git commit -m "feat(platform-types): add next-slots input and output contracts"
```

---

### Task 3: `GET /v2/slots/next`

**Files:**
- Create: `apps/api/v2/src/modules/slots/slots-2024-09-04/services/next-slots.service.ts`
- Create: `apps/api/v2/src/modules/slots/slots-2024-09-04/outputs/get-next-slots.output.ts`
- Modify: `apps/api/v2/src/modules/slots/slots-2024-09-04/controllers/slots.controller.ts`
- Modify: `apps/api/v2/src/modules/slots/slots-2024-09-04/slots.module.ts`

**Interfaces:**
- Consumes: `NextSlotsService`, `NextSlotCandidate`, `NextSlot` from `@calcom/platform-libraries/slots`; `GetNextSlotsInput_2024_09_04`, `NextSlot_2024_09_04` from `@calcom/platform-types`; the existing injectable `AvailableSlotsService` from `@/lib/services/available-slots.service`; `EventTypesRepository_2024_06_14`; `UsersRepository`.
- Produces: `NextSlotsService_2024_09_04` with `getNextSlotsForEventType(query: GetNextSlotsInput_2024_09_04): Promise<NextSlot[]>` and `buildCandidates(...)` — Task 4 reuses the class by importing it from the same path and calling `getNextSlots(candidates, ...)`.

- [ ] **Step 1: Write the service**

Create `apps/api/v2/src/modules/slots/slots-2024-09-04/services/next-slots.service.ts`:

```ts
import { EventTypesRepository_2024_06_14 } from "@/platform/event-types/event-types_2024_06_14/event-types.repository";
import { AvailableSlotsService } from "@/lib/services/available-slots.service";
import { UsersRepository } from "@/modules/users/users.repository";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";

import { NextSlotsService, type NextSlot, type NextSlotCandidate } from "@calcom/platform-libraries/slots";
import type { GetNextSlotsInput_2024_09_04 } from "@calcom/platform-types";

@Injectable()
export class NextSlotsService_2024_09_04 {
  private readonly engine: NextSlotsService;

  constructor(
    availableSlotsService: AvailableSlotsService,
    private readonly eventTypesRepository: EventTypesRepository_2024_06_14,
    private readonly usersRepository: UsersRepository
  ) {
    this.engine = new NextSlotsService(availableSlotsService);
  }

  async getNextSlotsForEventType(query: GetNextSlotsInput_2024_09_04): Promise<NextSlot[]> {
    const eventType = await this.resolveEventType(query);

    return this.getNextSlots({
      candidates: [
        {
          eventTypeId: eventType.id,
          eventTypeSlug: eventType.slug,
          duration: query.duration ?? eventType.length,
        },
      ],
      limit: query.limit,
      after: query.after,
      timeZone: query.timeZone,
      maxHorizonDays: query.maxHorizonDays,
    });
  }

  async getNextSlots({
    candidates,
    limit,
    after,
    timeZone,
    maxHorizonDays,
  }: {
    candidates: NextSlotCandidate[];
    limit: number;
    after?: string;
    timeZone?: string;
    maxHorizonDays?: number;
  }): Promise<NextSlot[]> {
    return this.engine.getNextSlots({
      candidates,
      limit,
      after: after ? new Date(after) : undefined,
      timeZone,
      maxHorizonDays,
    });
  }

  private async resolveEventType(query: GetNextSlotsInput_2024_09_04) {
    if (query.eventTypeId) {
      const eventType = await this.eventTypesRepository.getEventTypeById(query.eventTypeId);
      if (!eventType) throw new NotFoundException(`Event Type with ID=${query.eventTypeId} not found`);
      return eventType;
    }

    if (!query.username || !query.eventTypeSlug) {
      throw new BadRequestException(
        "Provide either 'eventTypeId', or both 'username' and 'eventTypeSlug'."
      );
    }

    const user = await this.usersRepository.findByUsername(query.username);
    if (!user) throw new NotFoundException(`User with username ${query.username} not found`);

    const eventType = await this.eventTypesRepository.getUserEventTypeBySlug(user.id, query.eventTypeSlug);
    if (!eventType) {
      throw new NotFoundException(
        `Event Type with slug ${query.eventTypeSlug} not found for user ${query.username}`
      );
    }
    return eventType;
  }
}
```

- [ ] **Step 2: Write the output DTO**

Create `apps/api/v2/src/modules/slots/slots-2024-09-04/outputs/get-next-slots.output.ts`:

```ts
import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ValidateNested } from "class-validator";

import { ApiResponseWithoutData, NextSlot_2024_09_04 } from "@calcom/platform-types";

export class GetNextSlotsOutput_2024_09_04 extends ApiResponseWithoutData {
  @ApiProperty({ type: [NextSlot_2024_09_04] })
  @ValidateNested({ each: true })
  @Type(() => NextSlot_2024_09_04)
  data!: NextSlot_2024_09_04[];
}
```

- [ ] **Step 3: Add the route to the existing controller**

In `apps/api/v2/src/modules/slots/slots-2024-09-04/controllers/slots.controller.ts`, inject the new service alongside `slotsService` and add the route **after** the existing `@Get("/")` handler and before `@Post("/reservations")`:

```ts
  @Get("/next")
  @UseGuards(OptionalApiAuthGuard)
  @ApiOperation({
    summary: "Get the next available time slots for an event type",
    description: `
      Returns the soonest available slots as a flat, time-ordered array, without the caller having to pick a date range.

      The event type is identified either by 'eventTypeId', or by 'username' plus 'eventTypeSlug'.

      Unlike '/v2/slots', the response is an array rather than an object keyed by date, and it is capped by 'limit' rather than by an end date. A response shorter than 'limit' means no further slots exist within 'maxHorizonDays'.

      The event type's minimum booking notice is respected, so a slot inside the notice window is never returned.
      `,
  })
  @DocsResponse({ status: 200, type: GetNextSlotsOutput_2024_09_04 })
  async getNextSlots(
    @Query() query: GetNextSlotsInput_2024_09_04
  ): Promise<GetNextSlotsOutput_2024_09_04> {
    const slots = await this.nextSlotsService.getNextSlotsForEventType(query);

    return {
      status: SUCCESS_STATUS,
      data: slots,
    };
  }
```

Add the matching imports: `NextSlotsService_2024_09_04`, `GetNextSlotsOutput_2024_09_04`, and `GetNextSlotsInput_2024_09_04` from `@calcom/platform-types`.

- [ ] **Step 4: Register the provider**

In `slots.module.ts`, add `NextSlotsService_2024_09_04` to `providers` and to `exports` (Task 4's controller needs it).

- [ ] **Step 5: Type check**

Run: `yarn type-check:ci --force`
Expected: no new errors.

- [ ] **Step 6: Smoke-check the route shape**

Run: `cd apps/api/v2 && yarn build`
Expected: build succeeds; the new route is registered without a path conflict against `/reservations/:uid`.

- [ ] **Step 7: Commit**

```bash
yarn biome check --write apps/api/v2/src/modules/slots
git add apps/api/v2/src/modules/slots
git commit -m "feat(api-v2): add GET /v2/slots/next"
```

---

### Task 4: `GET /v2/oauth-clients/{clientId}/slots/next`

**Files:**
- Create: `apps/api/v2/src/modules/oauth-clients/controllers/oauth-client-slots/oauth-client-slots.controller.ts`
- Modify: `apps/api/v2/src/modules/users/users.repository.ts`
- Modify: `apps/api/v2/src/modules/oauth-clients/oauth-client.module.ts`

**Interfaces:**
- Consumes: `NextSlotsService_2024_09_04` (Task 3), `GetClientNextSlotsInput_2024_09_04` and `NextSlot_2024_09_04` (Task 2), `GetNextSlotsOutput_2024_09_04` (Task 3), the `ApiAuthGuard` + `OAuthClientGuard` pairing used by `OAuthClientUsersController`.
- Produces: `UsersRepository.findManagedUsersWithBookableEventTypes(oauthClientId: string, eventTypeSlug?: string)` returning `{ id, username, name, ownedEventTypes: { id, slug, length }[] }[]`.

- [ ] **Step 1: Add the repository method**

Append to `apps/api/v2/src/modules/users/users.repository.ts`. Note `ownedEventTypes`, not `eventTypes` — the latter is the `user_eventtype` many-to-many, while `ownedEventTypes` is the `userId` owner relation that `getUserEventTypesPublic` filters on:

```ts
  async findManagedUsersWithBookableEventTypes(oauthClientId: string, eventTypeSlug?: string) {
    return this.dbRead.prisma.user.findMany({
      where: {
        platformOAuthClients: { some: { id: oauthClientId } },
        isPlatformManaged: true,
      },
      select: {
        id: true,
        username: true,
        name: true,
        ownedEventTypes: {
          where: {
            hidden: false,
            ...(eventTypeSlug ? { slug: eventTypeSlug } : {}),
          },
          select: { id: true, slug: true, length: true },
        },
      },
    });
  }
```

- [ ] **Step 2: Write the controller**

Create `apps/api/v2/src/modules/oauth-clients/controllers/oauth-client-slots/oauth-client-slots.controller.ts`:

```ts
import { API_VERSIONS_VALUES } from "@/lib/api-versions";
import { ApiAuthGuard } from "@/modules/auth/guards/api-auth/api-auth.guard";
import { OAuthClientGuard } from "@/modules/oauth-clients/guards/oauth-client-guard";
import { GetNextSlotsOutput_2024_09_04 } from "@/modules/slots/slots-2024-09-04/outputs/get-next-slots.output";
import { NextSlotsService_2024_09_04 } from "@/modules/slots/slots-2024-09-04/services/next-slots.service";
import { UsersRepository } from "@/modules/users/users.repository";
import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiResponse as DocsResponse, ApiTags as DocsTags } from "@nestjs/swagger";

import { X_CAL_SECRET_KEY } from "@calcom/platform-constants";
import { SUCCESS_STATUS } from "@calcom/platform-constants";
import type { NextSlotCandidate } from "@calcom/platform-libraries/slots";
import { GetClientNextSlotsInput_2024_09_04 } from "@calcom/platform-types";

@Controller({
  path: "/v2/oauth-clients/:clientId/slots",
  version: API_VERSIONS_VALUES,
})
@UseGuards(ApiAuthGuard, OAuthClientGuard)
@DocsTags("Platform / Managed Users")
@ApiHeader({
  name: X_CAL_SECRET_KEY,
  description: "OAuth client secret key",
  required: true,
})
export class OAuthClientSlotsController {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly nextSlotsService: NextSlotsService_2024_09_04
  ) {}

  @Get("/next")
  @ApiOperation({
    summary: "Get the next available time slots across all managed users",
    description: `
      Returns the soonest available slots across every managed user of the OAuth client, as a flat, time-ordered array, each slot tagged with the user it is bookable with.

      By default every bookable event type each managed user owns is searched, so the returned slots can differ in duration — use 'eventTypeId' and 'duration' on each slot to tell them apart, or pass 'eventTypeSlug' to narrow the search.

      Managed users with no bookable event type are skipped. A response shorter than 'limit' means no further slots exist within 'maxHorizonDays'.
      `,
  })
  @DocsResponse({ status: 200, type: GetNextSlotsOutput_2024_09_04 })
  async getNextSlots(
    @Param("clientId") clientId: string,
    @Query() query: GetClientNextSlotsInput_2024_09_04
  ): Promise<GetNextSlotsOutput_2024_09_04> {
    const users = await this.usersRepository.findManagedUsersWithBookableEventTypes(
      clientId,
      query.eventTypeSlug
    );

    const candidates: NextSlotCandidate[] = users.flatMap((user) =>
      user.ownedEventTypes.map((eventType) => ({
        eventTypeId: eventType.id,
        eventTypeSlug: eventType.slug,
        duration: eventType.length,
        user: { id: user.id, username: user.username, name: user.name },
      }))
    );

    const slots = await this.nextSlotsService.getNextSlots({
      candidates,
      limit: query.limit,
      after: query.after,
      timeZone: query.timeZone,
      maxHorizonDays: query.maxHorizonDays,
    });

    return {
      status: SUCCESS_STATUS,
      data: slots,
    };
  }
}
```

- [ ] **Step 3: Register the controller**

In `apps/api/v2/src/modules/oauth-clients/oauth-client.module.ts`:
- add `SlotsModule_2024_09_04` to `imports` (it exports `NextSlotsService_2024_09_04` after Task 3 step 4),
- add `OAuthClientSlotsController` to `controllers`.

- [ ] **Step 4: Type check and build**

Run: `yarn type-check:ci --force` then `cd apps/api/v2 && yarn build`
Expected: both clean. If Nest reports a circular module import between `SlotsModule_2024_09_04` and `OAuthClientModule`, wrap the import as `forwardRef(() => SlotsModule_2024_09_04)`.

- [ ] **Step 5: Commit**

```bash
yarn biome check --write apps/api/v2/src/modules
git add apps/api/v2/src/modules/oauth-clients apps/api/v2/src/modules/users/users.repository.ts
git commit -m "feat(api-v2): add GET /v2/oauth-clients/:clientId/slots/next"
```

---

### Task 5: tRPC procedure for the web app

**Files:**
- Create: `packages/trpc/server/routers/viewer/availability/team/resolveOAuthClientOrganization.ts`
- Create: `packages/trpc/server/routers/viewer/availability/team/nextSlots.schema.ts`
- Create: `packages/trpc/server/routers/viewer/availability/team/nextSlots.handler.ts`
- Modify: `packages/trpc/server/routers/viewer/availability/team/listTeamAvailability.handler.ts`
- Modify: `packages/trpc/server/routers/viewer/availability/_router.tsx`

**Interfaces:**
- Consumes: `NextSlotsService` and `NextSlot` from Task 1; `getAvailableSlotsService()` from `@calcom/features/di/containers/AvailableSlots`.
- Produces: `trpc.viewer.availability.nextSlots` — input `{ oAuthClientId: string; userIds: number[]; maxHorizonDays?: number }`, output `Record<string, { start: string; end: string; eventTypeId: number; eventTypeSlug: string; duration: number } | null>` keyed by user id as a string. Task 6 consumes exactly this.

- [ ] **Step 1: Extract the authorization helper**

Cut `resolveOAuthClientOrganization` (including its docblock) out of `listTeamAvailability.handler.ts` into `resolveOAuthClientOrganization.ts`, exporting it, and import it back in `listTeamAvailability.handler.ts`. The function body is unchanged — this is a move so a second handler can reuse the same membership check.

- [ ] **Step 2: Verify the move broke nothing**

Run: `TZ=UTC yarn vitest run packages/trpc/server/routers/viewer/availability/team/listTeamAvailability.handler.test.ts`
Expected: PASS, same count as before the move.

- [ ] **Step 3: Write the schema**

Create `nextSlots.schema.ts`:

```ts
import { z } from "zod";

export const ZNextSlotsInputSchema = z.object({
  oAuthClientId: z.string(),
  userIds: z.array(z.number().int()).min(1).max(50),
  maxHorizonDays: z.number().int().min(1).max(365).optional(),
});

export type TNextSlotsInputSchema = z.infer<typeof ZNextSlotsInputSchema>;
```

- [ ] **Step 4: Write the handler**

Create `nextSlots.handler.ts`:

```ts
import { getAvailableSlotsService } from "@calcom/features/di/containers/AvailableSlots";
import { prisma } from "@calcom/prisma";
import { NextSlotsService, type NextSlotCandidate } from "../../slots/nextSlots";
import type { TrpcSessionUser } from "../../../../types";
import type { TNextSlotsInputSchema } from "./nextSlots.schema";
import { resolveOAuthClientOrganization } from "./resolveOAuthClientOrganization";

type GetOptions = {
  ctx: { user: NonNullable<TrpcSessionUser> };
  input: TNextSlotsInputSchema;
};

export type NextSlotForUser = {
  start: string;
  end: string;
  eventTypeId: number;
  eventTypeSlug: string;
  duration: number;
};

export const nextSlotsHandler = async ({ ctx, input }: GetOptions) => {
  // Throws FORBIDDEN unless the caller administers the organization owning the client.
  await resolveOAuthClientOrganization({
    userId: ctx.user.id,
    oAuthClientId: input.oAuthClientId,
  });

  // Scoping by the client as well as the ids keeps a caller from probing users outside it.
  const users = await prisma.user.findMany({
    where: {
      id: { in: input.userIds },
      platformOAuthClients: { some: { id: input.oAuthClientId } },
    },
    select: {
      id: true,
      ownedEventTypes: {
        where: { hidden: false },
        select: { id: true, slug: true, length: true },
      },
    },
  });

  const candidates: NextSlotCandidate[] = users.flatMap((user) =>
    user.ownedEventTypes.map((eventType) => ({
      eventTypeId: eventType.id,
      eventTypeSlug: eventType.slug,
      duration: eventType.length,
      user: { id: user.id, username: null, name: null },
    }))
  );

  const service = new NextSlotsService(getAvailableSlotsService());
  const byEventType = await service.getNextSlotPerCandidate({
    candidates,
    maxHorizonDays: input.maxHorizonDays,
  });

  const result: Record<string, NextSlotForUser | null> = {};
  for (const userId of input.userIds) {
    result[String(userId)] = null;
  }

  for (const candidate of candidates) {
    const slot = byEventType.get(candidate.eventTypeId);
    if (!slot || !candidate.user) continue;
    const key = String(candidate.user.id);
    const current = result[key];
    // A user can own several event types; the soonest of them is what the grid shows.
    if (current && new Date(current.start) <= new Date(slot.start)) continue;
    result[key] = {
      start: slot.start,
      end: slot.end,
      eventTypeId: slot.eventTypeId,
      eventTypeSlug: slot.eventTypeSlug,
      duration: slot.duration,
    };
  }

  return result;
};
```

- [ ] **Step 5: Register the procedure**

In `_router.tsx`, add to `AvailabilityRouterHandlerCache` and the router:

```ts
  nextSlots: authedProcedure.input(ZNextSlotsInputSchema).query(async ({ ctx, input }) => {
    const { nextSlotsHandler } = await import("./team/nextSlots.handler");

    return nextSlotsHandler({ ctx, input });
  }),
```

with `import { ZNextSlotsInputSchema } from "./team/nextSlots.schema";` at the top.

- [ ] **Step 6: Rebuild tRPC types and type check**

Run: `yarn prisma generate && cd packages/trpc && yarn build && cd ../.. && yarn type-check:ci --force`
Expected: no new errors; `trpc.viewer.availability.nextSlots` resolves in the web app.

- [ ] **Step 7: Commit**

```bash
yarn biome check --write packages/trpc/server/routers/viewer/availability
git add packages/trpc/server/routers/viewer/availability
git commit -m "feat(availability): add nextSlots procedure for managed users"
```

---

### Task 6: "Next available" column in the availability grid

**Files:**
- Modify: `apps/web/modules/timezone-buddy/components/AvailabilitySliderTable.tsx`
- Modify: `packages/i18n/locales/en/common.json`

**Interfaces:**
- Consumes: `trpc.viewer.availability.nextSlots` from Task 5, keyed by user id as a string.

- [ ] **Step 1: Add the translation strings**

In `packages/i18n/locales/en/common.json`, add:

```json
  "next_available": "Next available",
  "no_upcoming_availability": "No upcoming availability",
```

- [ ] **Step 2: Query the next slots for the rows on screen**

The component already builds `flatData` — but at line 178, *below* `memorisedColumns` (line 77), and the new column's cell closure has to read the query result. So first **move the existing `flatData` useMemo above `memorisedColumns`**, right after the `useInfiniteQuery` call. It depends only on `data`, so the move is mechanical and changes no behaviour:

```tsx
  const flatData = useMemo(() => data?.pages?.flatMap((page) => page.rows) ?? [], [data]) as SliderUser[];
```

Then, still above `memorisedColumns`, add:

```tsx
  const userIds = useMemo(() => flatData.map((user) => user.id), [flatData]);

  const { data: nextSlots, isPending: isNextSlotsPending } =
    trpc.viewer.availability.nextSlots.useQuery(
      { oAuthClientId, userIds },
      { enabled: userIds.length > 0, placeholderData: keepPreviousData }
    );
```

- [ ] **Step 3: Add the column**

Add to `memorisedColumns`, after the `timezone` column, and include `nextSlots` and `isNextSlotsPending` in the `useMemo` dependency array:

```tsx
      {
        id: "nextAvailable",
        header: t("next_available"),
        enableHiding: false,
        enableSorting: false,
        size: 180,
        cell: ({ row }) => {
          const slot = nextSlots?.[String(row.original.id)];
          if (isNextSlotsPending) {
            return <div className="bg-subtle h-4 w-24 animate-pulse rounded-md" />;
          }
          if (!slot) {
            return (
              <span className="text-subtle text-sm" title={t("no_upcoming_availability")}>
                &mdash;
              </span>
            );
          }
          return (
            <span className="text-emphasis text-sm">
              {dayjs(slot.start).tz(row.original.timeZone).format("MMM D, HH:mm")}
            </span>
          );
        },
      },
```

The slot is rendered in the **provider's** timezone, matching the `timezone` column the reader is looking at one cell to the left.

- [ ] **Step 4: Verify in the browser**

Run: `yarn dev`, sign in as a platform org admin, open `/availability`, and select a client tab.
Expected: the grid shows a "Next available" column; rows with availability show a date and time, rows without show an em dash; the column resolves after the grid paints rather than blocking it.

- [ ] **Step 5: Type check and lint**

Run: `yarn type-check:ci --force` then `yarn biome check --write apps/web packages/i18n`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/modules/timezone-buddy/components/AvailabilitySliderTable.tsx packages/i18n/locales/en/common.json
git commit -m "feat(availability): show each managed user's next available slot"
```

---

### Task 7: Update the Lavela contract doc and run the full gate

**Files:**
- Modify: `agents/lavela-health-integration.md`
- Modify: `specs/next-available-slots/implementation.md`

- [ ] **Step 1: Add the routes to §10**

In the "API surface consumed" table, after the `/slots` row:

```markdown
| `/slots/next` | GET | `2024-09-04` |
| `/oauth-clients/{clientId}/slots/next` | GET | — |
```

And in the "Response shapes Lavela parses positionally" list, after the Slots entry:

```markdown
- Next slots → `data` is a **flat array** ordered by `start`, each entry carrying `start`,
  `end`, `duration`, `eventTypeId`, `eventTypeSlug`, and — on the OAuth client route —
  `user` with `id`, `username`, `name`
```

- [ ] **Step 2: Add the invariant to §11**

Append as item 13:

```markdown
13. The next-slots routes (`/slots/next`, `/oauth-clients/{clientId}/slots/next`) must keep
    returning a flat array ordered by `start`, not an object keyed by date. This is the
    deliberate mirror of #10: the two slot surfaces have different shapes on purpose, and
    unifying them breaks one consumer or the other.
```

- [ ] **Step 3: Mark the spec complete**

Set `## Status: complete` in `specs/next-available-slots/implementation.md` and move the Next Steps items into Completed.

- [ ] **Step 4: Run the full gate**

Run, in order:
```bash
yarn type-check:ci --force
yarn biome check --write .
TZ=UTC yarn test
```
Expected: type check clean, Biome clean, tests pass. Investigate any failure in a file this branch touched; the known-ignorable CI failures listed in `agents/rules/ci-check-failures.md` (SAML postgres auth, "Invalid URL") do not apply locally.

- [ ] **Step 5: Commit and open the draft PR**

```bash
git add agents/lavela-health-integration.md specs/next-available-slots/implementation.md
git commit -m "docs(lavela): record the next-slots routes and their array-shape invariant"
git push -u origin feat/next-available-slots
gh pr create --draft --title "feat(slots): next available slots for providers and OAuth clients" --body "$(cat <<'BODY'
## What

Two new API v2 endpoints returning the soonest N bookable slots as a flat, time-ordered
array, plus a "Next available" column on the per-client availability grid.

| Route | Auth | Answers |
|---|---|---|
| `GET /v2/slots/next` | optional (same as `/v2/slots`) | next X slots for one provider |
| `GET /v2/oauth-clients/{clientId}/slots/next` | `x-cal-secret-key` | the X soonest slots across every managed user of the client |

`GET /v2/slots` is untouched — invariant #10 pins its date-keyed shape, so these are new
routes returning a different shape on purpose. A new invariant #13 records that.

## How

`NextSlotsService` (`packages/trpc/server/routers/viewer/slots/nextSlots.ts`) does windowed
expansion over `[7, 30, 90]` days with a global early exit: query every candidate over the
same window, and stop as soon as one window yields `limit` slots, because everything
outside the window starts later than everything inside it. The common case costs one
narrow window rather than a 90-day search.

Window bounds are day-aligned so repeated calls hit the existing `withSlotsCache` key.
`minimumBookingNotice` is respected for free via `getStartTime`.

## Note on size

This exceeds the repo's PR size guidance by explicit request. If you would rather review it
in pieces, the natural split is: (1) the engine + `GET /v2/slots/next`, (2) the aggregate
route, (3) the availability column.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_012pXoWPnHGi36wRzcqZv9ac
BODY
)"
```
