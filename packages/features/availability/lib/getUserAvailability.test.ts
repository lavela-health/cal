import dayjs from "@calcom/dayjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GetUserAvailabilityInitialData } from "./getUserAvailability";
import { UserAvailabilityService } from "./getUserAvailability";

vi.mock("@calcom/features/di/containers/BusyTimes", () => ({
  getBusyTimesService: vi.fn(() => mockBusyTimesService),
}));

vi.mock("@calcom/features/busyTimes/lib/getBusyTimesFromLimits", () => ({
  getBusyTimesFromLimits: vi.fn().mockResolvedValue([]),
  getBusyTimesFromTeamLimits: vi.fn().mockResolvedValue([]),
}));

vi.mock("@calcom/app-store/_utils/getCalendar", () => ({
  getCalendar: vi.fn(),
}));

vi.mock("@calcom/lib/holidays", () => ({
  getHolidayService: vi.fn(() => ({
    getHolidayDatesInRange: vi.fn().mockResolvedValue([]),
  })),
}));

const mockBusyTimesService = {
  getStartEndDateforLimitCheck: vi.fn().mockReturnValue({
    limitDateFrom: dayjs("2025-01-01T00:00:00Z"),
    limitDateTo: dayjs("2025-01-31T23:59:59Z"),
  }),
  getBusyTimesForLimitChecks: vi.fn().mockResolvedValue([]),
  getBusyTimes: vi.fn().mockResolvedValue([]),
};

const mockDependencies: ConstructorParameters<typeof UserAvailabilityService>[0] = {
  oooRepo: { findUserOOODays: vi.fn().mockResolvedValue([]) },
  bookingRepo: { findAcceptedBookingByEventTypeId: vi.fn().mockResolvedValue([]) },
  redisClient: { get: vi.fn().mockResolvedValue(null), set: vi.fn() },
  eventTypeRepo: {
    findByIdForUserAvailability: vi.fn().mockResolvedValue(null),
    findForSlots: vi.fn().mockResolvedValue(null),
  },
  holidayRepo: { findUserSettingsSelect: vi.fn().mockResolvedValue(null) },
};

// A Monday-to-Friday 09:00-17:00 schedule, queried over one Tuesday.
const TUESDAY_FROM = "2025-01-07T00:00:00Z";
const TUESDAY_TO = "2025-01-07T23:59:59Z";

const workingHours = {
  days: [1, 2, 3, 4, 5],
  startTime: new Date("1970-01-01T09:00:00Z"),
  endTime: new Date("1970-01-01T17:00:00Z"),
  date: null,
};

const mockUser = (): NonNullable<GetUserAvailabilityInitialData["user"]> => ({
  id: 1,
  username: "provider",
  email: "provider@example.com",
  bufferTime: 0,
  timeZone: "UTC",
  availability: [{ id: 1, userId: 1, eventTypeId: null, scheduleId: 1, ...workingHours }],
  timeFormat: 12,
  defaultScheduleId: 1,
  isPlatformManaged: true,
  schedules: [{ id: 1, availability: [workingHours], timeZone: "UTC" }],
  credentials: [],
  allSelectedCalendars: [],
  userLevelSelectedCalendars: [],
  travelSchedules: [],
});

const totalMinutes = (ranges: { start: dayjs.Dayjs; end: dayjs.Dayjs }[]): number =>
  ranges.reduce((sum, { start, end }) => sum + end.diff(start, "minute"), 0);

describe("UserAvailabilityService.getUserAvailability", () => {
  let service: UserAvailabilityService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBusyTimesService.getBusyTimes.mockResolvedValue([]);
    service = new UserAvailabilityService(mockDependencies);
  });

  const getAvailability = () =>
    service.getUserAvailability(
      {
        dateFrom: dayjs(TUESDAY_FROM),
        dateTo: dayjs(TUESDAY_TO),
        returnDateOverrides: false,
      },
      { user: mockUser() }
    );

  it("returns the scheduled ranges as they stood before busy times were subtracted", async () => {
    mockBusyTimesService.getBusyTimes.mockResolvedValue([
      { start: new Date("2025-01-07T11:00:00Z"), end: new Date("2025-01-07T12:00:00Z") },
    ]);

    const result = await getAvailability();

    expect(totalMinutes(result.dateRanges)).toBe(420);
    expect(totalMinutes(result.scheduledDateRanges)).toBe(480);
  });

  it("reports a failed calendar read rather than an empty schedule", async () => {
    mockBusyTimesService.getBusyTimes.mockRejectedValue(new Error("Failed to fetch busy calendar times"));

    const result = await getAvailability();

    expect(result.calendarFetchFailed).toBe(true);
    expect(result.dateRanges).toEqual([]);
    // What was scheduled is still known; only what was taken from it is not.
    expect(totalMinutes(result.scheduledDateRanges)).toBe(480);
  });

  it("does not flag a calendar read that succeeded", async () => {
    const result = await getAvailability();

    expect(result.calendarFetchFailed).toBe(false);
  });

  // calculateOutOfOfficeRanges clamps a start date in the past to today, so this has to sit in
  // the future to exercise the OOO path at all.
  it("leaves out-of-office days out of the scheduled ranges", async () => {
    const tuesday = dayjs.utc().add(1, "week").day(2).startOf("day");
    mockDependencies.oooRepo.findUserOOODays = vi.fn().mockResolvedValue([
      {
        start: tuesday.toDate(),
        end: tuesday.endOf("day").toDate(),
        user: { id: 1, name: "Provider" },
        toUser: null,
        reason: null,
        notes: null,
        showNotePublicly: false,
      },
    ]);
    service = new UserAvailabilityService(mockDependencies);

    const result = await service.getUserAvailability(
      { dateFrom: tuesday, dateTo: tuesday.endOf("day"), returnDateOverrides: false },
      { user: mockUser() }
    );

    // dateRanges ignores OOO by design; the scheduled baseline must not, or a provider on
    // holiday reads as offering a full week they were never available for.
    expect(totalMinutes(result.dateRanges)).toBe(480);
    expect(totalMinutes(result.scheduledDateRanges)).toBe(0);
  });
});
