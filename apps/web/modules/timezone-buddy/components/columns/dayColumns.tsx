import type { Dayjs } from "@calcom/dayjs";
import dayjs from "@calcom/dayjs";
import { Badge } from "@calcom/ui/components/badge";
import { Button } from "@calcom/ui/components/button";
import { ButtonGroup } from "@calcom/ui/components/buttonGroup";
import { DatePicker } from "@calcom/ui/components/form/datepicker";
import type { ColumnDef } from "@tanstack/react-table";
import { TimeDial } from "../TimeDial";
import type { SliderUser } from "./types";

type Translate = (key: string, vars?: Record<string, unknown>) => string;

type NextSlot = { start: string };

type DayColumnsArgs = {
  t: Translate;
  browsingDate: Dayjs;
  onBrowsingDateChange: (date: Dayjs) => void;
  nextSlots: Record<string, NextSlot | null> | undefined;
  isNextSlotsPending: boolean;
  isShowingRecordedData: boolean;
};

export function buildDayColumns({
  t,
  browsingDate,
  onBrowsingDateChange,
  nextSlots,
  isNextSlotsPending,
  isShowingRecordedData,
}: DayColumnsArgs): ColumnDef<SliderUser>[] {
  return [
    {
      id: "nextAvailable",
      header: isShowingRecordedData ? "" : t("next_available"),
      enableHiding: false,
      enableSorting: false,
      size: 180,
      cell: ({ row }) => {
        if (isShowingRecordedData) {
          return <span className="text-sm text-subtle">&mdash;</span>;
        }
        const slot = nextSlots?.[String(row.original.id)];
        if (isNextSlotsPending) {
          return <div className="h-4 w-24 animate-pulse rounded-md bg-subtle" />;
        }
        if (!slot) {
          return (
            <span className="text-sm text-subtle" title={t("no_upcoming_availability")}>
              &mdash;
            </span>
          );
        }
        // Rendered in the provider's own timezone, matching the column beside it.
        return (
          <span className="text-emphasis text-sm">
            {dayjs(slot.start).tz(row.original.timeZone).format("MMM D, HH:mm")}
          </span>
        );
      },
    },
    {
      id: "timezone",
      accessorFn: (data) => data.timeZone,
      header: "Timezone",
      enableHiding: false,
      enableSorting: false,
      size: 160,
      cell: ({ row }) => {
        const { timeZone } = row.original;
        const timeRaw = dayjs().tz(timeZone);
        const time = timeRaw.format("HH:mm");
        const utcOffsetInMinutes = timeRaw.utcOffset();
        const hours = Math.abs(Math.floor(utcOffsetInMinutes / 60));
        const minutes = Math.abs(utcOffsetInMinutes % 60);
        const offsetFormatted = `${utcOffsetInMinutes < 0 ? "-" : "+"}${hours
          .toString()
          .padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;

        return (
          <div className="flex flex-col text-center">
            <span className="font-medium text-default text-sm">{time}</span>
            <span className="text-subtle text-xs leading-none">GMT {offsetFormatted}</span>
          </div>
        );
      },
    },
    {
      id: "slider",
      meta: {
        autoWidth: true,
      },
      enableHiding: false,
      enableSorting: false,
      header: () => {
        return (
          <div className="flex items-center space-x-2">
            <ButtonGroup containerProps={{ className: "space-x-0" }}>
              <Button
                color="minimal"
                variant="icon"
                StartIcon="chevron-left"
                onClick={() => onBrowsingDateChange(browsingDate.subtract(1, "day"))}
              />
              <Button
                onClick={() => onBrowsingDateChange(browsingDate.add(1, "day"))}
                color="minimal"
                StartIcon="chevron-right"
                variant="icon"
              />
            </ButtonGroup>
            <span>{browsingDate.format("LL")}</span>
            <DatePicker
              date={browsingDate.toDate()}
              onDatesChange={(date) => onBrowsingDateChange(dayjs(date))}
              minDate={null}
              label={t("availability_jump_to_date")}
              className="w-auto"
            />
            {isShowingRecordedData && (
              <Badge variant="orange" title={t("availability_recorded_history_description")}>
                {t("availability_recorded_history")}
              </Badge>
            )}
          </div>
        );
      },
      cell: ({ row }) => {
        const { timeZone, dateRanges, availabilitySource } = row.original;

        if (availabilitySource === "unrecorded") {
          return (
            <span className="text-sm text-subtle" title={t("availability_no_recorded_history_description")}>
              {t("availability_no_recorded_history")}
            </span>
          );
        }

        return <TimeDial timezone={timeZone} dateRanges={dateRanges} />;
      },
    },
  ];
}
