import type { Dayjs } from "@calcom/dayjs";
import type { WeeklyHours } from "@calcom/features/availability/services/WeeklyAvailabilityService";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import type { ViewMode } from "../AvailabilityViewToolbar";
import { buildDayColumns } from "./dayColumns";
import { buildMemberColumn } from "./memberColumn";
import type { SliderUser } from "./types";
import { buildWeekColumns } from "./weekColumns";

type UseAvailabilityColumnsArgs = {
  viewMode: ViewMode;
  browsingDate: Dayjs;
  onBrowsingDateChange: (date: Dayjs) => void;
  nextSlots: Record<string, { start: string } | null> | undefined;
  isNextSlotsPending: boolean;
  isShowingRecordedData: boolean;
  weeklyHours: Record<string, WeeklyHours> | undefined;
  isWeeklyHoursPending: boolean;
};

/** The member column is shared; the rest belong to whichever view is showing. */
export function useAvailabilityColumns({
  viewMode,
  browsingDate,
  onBrowsingDateChange,
  nextSlots,
  isNextSlotsPending,
  isShowingRecordedData,
  weeklyHours,
  isWeeklyHoursPending,
}: UseAvailabilityColumnsArgs): ColumnDef<SliderUser>[] {
  const { t } = useLocale();

  return useMemo(() => {
    const member = buildMemberColumn(t);

    if (viewMode === "week") {
      return [
        member,
        // Holding the previous week's rows through a refetch means isPending alone would
        // skeleton columns that already have numbers in them.
        ...buildWeekColumns({ t, weeklyHours, isPending: isWeeklyHoursPending && !weeklyHours }),
      ];
    }

    return [
      member,
      ...buildDayColumns({
        t,
        browsingDate,
        onBrowsingDateChange,
        nextSlots,
        isNextSlotsPending,
        isShowingRecordedData,
      }),
    ];
  }, [
    t,
    viewMode,
    browsingDate,
    onBrowsingDateChange,
    nextSlots,
    isNextSlotsPending,
    isShowingRecordedData,
    weeklyHours,
    isWeeklyHoursPending,
  ]);
}
