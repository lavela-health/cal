import type { WeeklyHours } from "@calcom/features/availability/services/WeeklyAvailabilityService";
import type { ColumnDef } from "@tanstack/react-table";
import { formatMinutesAsHours } from "../../lib/formatMinutesAsHours";
import type { SliderUser } from "./types";

type Translate = (key: string, vars?: Record<string, unknown>) => string;

type WeekColumnsArgs = {
  t: Translate;
  weeklyHours: Record<string, WeeklyHours> | undefined;
  isPending: boolean;
};

type Figure = keyof Pick<
  WeeklyHours,
  "scheduledMinutes" | "blockedMinutes" | "bookedMinutes" | "capacityMinutes" | "freeMinutes"
>;

const COLUMNS: { id: string; label: string; figure: Figure; description: string }[] = [
  {
    id: "scheduledHours",
    label: "availability_scheduled",
    figure: "scheduledMinutes",
    description: "availability_scheduled_description",
  },
  {
    id: "blockedHours",
    label: "availability_blocked",
    figure: "blockedMinutes",
    description: "availability_blocked_description",
  },
  {
    id: "bookedHours",
    label: "availability_booked",
    figure: "bookedMinutes",
    description: "availability_booked_description",
  },
  {
    id: "capacityHours",
    label: "availability_capacity",
    figure: "capacityMinutes",
    description: "availability_capacity_description",
  },
  {
    id: "freeHours",
    label: "availability_free",
    figure: "freeMinutes",
    description: "availability_free_description",
  },
];

/**
 * Why a figure is missing decides what the dash means, and the two reasons must not look alike:
 * a week nobody recorded the calendar for is a gap in the record, while an unreadable calendar is
 * a broken connection somebody has to go and fix.
 */
function blankReason(entry: WeeklyHours): string {
  if (entry.calendarFetchFailed) return "availability_calendar_unreadable";
  if (entry.source === "unrecorded") return "availability_no_recorded_history_description";
  return "availability_no_recorded_calendar_history";
}

export function buildWeekColumns({ t, weeklyHours, isPending }: WeekColumnsArgs): ColumnDef<SliderUser>[] {
  return COLUMNS.map(({ id, label, figure, description }) => ({
    id,
    enableHiding: false,
    enableSorting: false,
    size: 130,
    header: () => <span title={t(description)}>{t(label)}</span>,
    cell: ({ row }) => {
      const entry = weeklyHours?.[String(row.original.id)];

      if (isPending || !entry) {
        return <div className="h-4 w-16 animate-pulse rounded-md bg-subtle" />;
      }

      const minutes = entry[figure];

      if (minutes === null) {
        return (
          <span className="text-sm text-subtle" title={t(blankReason(entry))}>
            &mdash;
          </span>
        );
      }

      return <span className="text-emphasis text-sm">{formatMinutesAsHours(minutes, t)}</span>;
    },
  }));
}
