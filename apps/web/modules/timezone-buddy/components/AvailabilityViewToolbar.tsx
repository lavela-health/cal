import type { Dayjs } from "@calcom/dayjs";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Button } from "@calcom/ui/components/button";
import { ButtonGroup } from "@calcom/ui/components/buttonGroup";
import { ToggleGroup } from "@calcom/ui/components/form";
import { DataTableToolbar } from "~/data-table/components";

type ViewMode = "day" | "week";

const DAYS_PER_WEEK = 7;

type AvailabilityViewToolbarProps = {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  weekStart: Dayjs;
  onWeekStartChange: (date: Dayjs) => void;
  /** Renders the note explaining why a past week's calendar-derived figures are blank. */
  isShowingRecordedWeek: boolean;
};

export function AvailabilityViewToolbar({
  viewMode,
  onViewModeChange,
  weekStart,
  onWeekStartChange,
  isShowingRecordedWeek,
}: AvailabilityViewToolbarProps) {
  const { t } = useLocale();

  return (
    <DataTableToolbar.Root>
      {/* One grid child, laid out as a row: Toolbar.Root is a single-column grid, so several
          children would stack on top of each other instead. */}
      <div className="flex flex-wrap items-center gap-2">
        <DataTableToolbar.SearchBar />
        <ToggleGroup
          value={viewMode}
          onValueChange={(value) => value && onViewModeChange(value as ViewMode)}
          options={[
            { value: "day", label: t("day") },
            { value: "week", label: t("week") },
          ]}
        />
        {viewMode === "week" && (
          <div className="flex items-center gap-2">
            <ButtonGroup containerProps={{ className: "space-x-0" }}>
              <Button
                color="minimal"
                variant="icon"
                StartIcon="chevron-left"
                aria-label={t("availability_previous_week")}
                onClick={() => onWeekStartChange(weekStart.subtract(DAYS_PER_WEEK, "day"))}
              />
              <Button
                color="minimal"
                variant="icon"
                StartIcon="chevron-right"
                aria-label={t("availability_next_week")}
                onClick={() => onWeekStartChange(weekStart.add(DAYS_PER_WEEK, "day"))}
              />
            </ButtonGroup>
            <span className="whitespace-nowrap text-default text-sm">
              {t("availability_week_of", { date: weekStart.format("LL") })}
            </span>
          </div>
        )}
      </div>
      {isShowingRecordedWeek && (
        <p className="text-sm text-subtle">{t("availability_past_week_calendar_note")}</p>
      )}
    </DataTableToolbar.Root>
  );
}

export type { ViewMode };
