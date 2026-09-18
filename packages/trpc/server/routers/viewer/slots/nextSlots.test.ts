import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ISlotsProvider,
  NEXT_SLOTS_DEFAULT_MAX_HORIZON_DAYS,
  type NextSlotCandidate,
  NextSlotsService,
} from "./nextSlots";
import type { GetScheduleOptions } from "./types";

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
    expect(windows[0].endTime).toBe("2026-09-16T23:59:59.999Z");
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
    expect(windows[0].endTime).toBe("2026-09-16T23:59:59.999Z");
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
    expect(windows[1].endTime).toBe("2026-09-23T23:59:59.999Z");
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

  describe("getNextSlotsPerGroup", () => {
    it("answers each group independently, soonest first", async () => {
      const { provider } = stubProvider({
        1: [["2026-09-12T15:00:00.000Z", "2026-09-12T14:00:00.000Z"]],
        2: [["2026-09-13T09:00:00.000Z"]],
      });
      const service = new NextSlotsService(provider);

      const result = await service.getNextSlotsPerGroup({
        groups: new Map([
          ["a", [candidate(1)]],
          ["b", [candidate(2)]],
        ]),
        limit: 2,
        after: AFTER,
      });

      expect(result.get("a")?.slots.map((slot) => slot.start)).toEqual([
        "2026-09-12T14:00:00.000Z",
        "2026-09-12T15:00:00.000Z",
      ]);
      expect(result.get("b")?.slots.map((slot) => slot.start)).toEqual(["2026-09-13T09:00:00.000Z"]);
    });

    it("merges a group's event types into one soonest-first answer", async () => {
      const { provider } = stubProvider({
        1: [["2026-09-12T15:00:00.000Z"]],
        2: [["2026-09-12T14:00:00.000Z"]],
      });
      const service = new NextSlotsService(provider);

      const result = await service.getNextSlotsPerGroup({
        groups: new Map([[7, [candidate(1), candidate(2)]]]),
        limit: 2,
        after: AFTER,
      });

      // One answer for the group, not one per event type.
      expect(result.get(7)?.slots.map((slot) => slot.eventTypeId)).toEqual([2, 1]);
    });

    it("caps each group at limit rather than the groups together", async () => {
      const { provider } = stubProvider({
        1: [["2026-09-12T14:00:00.000Z", "2026-09-12T15:00:00.000Z", "2026-09-12T16:00:00.000Z"]],
        2: [["2026-09-12T14:30:00.000Z", "2026-09-12T15:30:00.000Z"]],
      });
      const service = new NextSlotsService(provider);

      const result = await service.getNextSlotsPerGroup({
        groups: new Map([
          [1, [candidate(1)]],
          [2, [candidate(2)]],
        ]),
        limit: 1,
        after: AFTER,
      });

      expect(result.get(1)?.slots).toHaveLength(1);
      expect(result.get(2)?.slots).toHaveLength(1);
    });

    it("reports an empty horizon as searched, not failed", async () => {
      const { provider } = stubProvider({ 1: [[], [], []] });
      const service = new NextSlotsService(provider);

      const result = await service.getNextSlotsPerGroup({
        groups: new Map([[1, [candidate(1)]]]),
        limit: 1,
        after: AFTER,
      });

      expect(result.get(1)).toEqual({ slots: [], searchFailed: false });
    });

    it("flags a group whose every candidate threw, so emptiness is not mistaken for fully booked", async () => {
      const provider: ISlotsProvider = {
        async getAvailableSlots({ input }: GetScheduleOptions) {
          if (input.eventTypeId === 1) throw new Error("calendar unreachable");
          return { slots: { "2026-09-12": [{ time: "2026-09-12T14:00:00.000Z" }] } };
        },
      };
      const service = new NextSlotsService(provider);

      const result = await service.getNextSlotsPerGroup({
        groups: new Map([
          ["broken", [candidate(1)]],
          ["healthy", [candidate(2)]],
        ]),
        limit: 1,
        after: AFTER,
      });

      expect(result.get("broken")).toEqual({ slots: [], searchFailed: true });
      expect(result.get("healthy")?.searchFailed).toBe(false);
    });

    it("does not flag a group where only some candidates threw", async () => {
      const provider: ISlotsProvider = {
        async getAvailableSlots({ input }: GetScheduleOptions) {
          if (input.eventTypeId === 1) throw new Error("calendar unreachable");
          return { slots: {} };
        },
      };
      const service = new NextSlotsService(provider);

      const result = await service.getNextSlotsPerGroup({
        groups: new Map([["partial", [candidate(1), candidate(2)]]]),
        limit: 1,
        after: AFTER,
      });

      // Event type 2 answered, so "fully booked" is a claim we can stand behind.
      expect(result.get("partial")).toEqual({ slots: [], searchFailed: false });
    });

    it("answers a group with no candidates as empty rather than failed", async () => {
      const { provider } = stubProvider({});
      const service = new NextSlotsService(provider);

      const result = await service.getNextSlotsPerGroup({
        groups: new Map([[1, [] as NextSlotCandidate[]]]),
        limit: 1,
        after: AFTER,
      });

      // Present but empty, and explicitly not a failure: there was nothing to search.
      expect(result.get(1)).toEqual({ slots: [], searchFailed: false });
    });

    it("honours the concurrency cap across groups", async () => {
      const { provider, getMaxInFlight } = stubProvider(
        Object.fromEntries(
          Array.from({ length: 10 }, (_, index) => [index + 1, [["2026-09-12T14:00:00.000Z"]]])
        )
      );
      const service = new NextSlotsService(provider, 3);

      await service.getNextSlotsPerGroup({
        groups: new Map(Array.from({ length: 10 }, (_, index) => [index, [candidate(index + 1)]])),
        limit: 1,
        after: AFTER,
      });

      expect(getMaxInFlight()).toBeLessThanOrEqual(3);
    });

    it("widens the window per group, independently", async () => {
      const { provider, windows } = stubProvider({
        1: [["2026-09-12T14:00:00.000Z"]],
        2: [[], ["2026-10-01T14:00:00.000Z"]],
      });
      const service = new NextSlotsService(provider);

      const result = await service.getNextSlotsPerGroup({
        groups: new Map([
          [1, [candidate(1)]],
          [2, [candidate(2)]],
        ]),
        limit: 1,
        after: AFTER,
      });

      expect(result.get(1)?.slots).toHaveLength(1);
      expect(result.get(2)?.slots.map((slot) => slot.start)).toEqual(["2026-10-01T14:00:00.000Z"]);
      // The group that answered on the 7-day window was not re-queried on the 30-day one.
      expect(windows.filter((window) => window.eventTypeId === 1)).toHaveLength(1);
      expect(windows.filter((window) => window.eventTypeId === 2)).toHaveLength(2);
    });

    it("passes after, timeZone and maxHorizonDays through to each group", async () => {
      const getAvailableSlots = vi.fn(async () => ({ slots: {} }));
      const service = new NextSlotsService({ getAvailableSlots });

      await service.getNextSlotsPerGroup({
        groups: new Map([[1, [candidate(1, { duration: 25 })]]]),
        limit: 1,
        after: AFTER,
        timeZone: "Europe/Rome",
        maxHorizonDays: 7,
      });

      expect(getAvailableSlots).toHaveBeenCalledTimes(1);
      expect(getAvailableSlots).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            timeZone: "Europe/Rome",
            duration: 25,
            startTime: "2026-09-10T00:00:00.000Z",
            endTime: "2026-09-16T23:59:59.999Z",
          }),
        })
      );
    });
  });
});
