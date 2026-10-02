"use client";

import dayjs from "@calcom/dayjs";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { CURRENT_TIMEZONE } from "@calcom/lib/timezoneConstants";
import { trpc } from "@calcom/trpc/react";
import { EmptyScreen } from "@calcom/ui/components/empty-screen";
import { keepPreviousData } from "@tanstack/react-query";
import { getCoreRowModel, getFilteredRowModel, useReactTable } from "@tanstack/react-table";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataTable } from "~/data-table/components";
import { DataTableProvider } from "~/data-table/DataTableProvider";
import { useDataTable } from "~/data-table/hooks/useDataTable";
import { mondayOf } from "../lib/mondayOf";
import { createTimezoneBuddyStore, TBContext } from "../store";
import type { ViewMode } from "./AvailabilityViewToolbar";
import { AvailabilityViewToolbar } from "./AvailabilityViewToolbar";
import { CellHighlightContainer } from "./CellHighlightContainer";
import type { SliderUser } from "./columns/types";
import { useAvailabilityColumns } from "./columns/useAvailabilityColumns";

type AvailabilitySliderTableProps = {
  oAuthClientId: string;
};

export function AvailabilitySliderTable({ oAuthClientId }: AvailabilitySliderTableProps) {
  const pathname = usePathname();

  // Every tab shares a pathname, so without the client id in the identifier the search term
  // would leak across tabs with nothing on screen explaining the filtered result.
  return (
    <DataTableProvider tableIdentifier={`${pathname}-${oAuthClientId}`}>
      <AvailabilitySliderTableContent oAuthClientId={oAuthClientId} />
    </DataTableProvider>
  );
}

function AvailabilitySliderTableContent({ oAuthClientId }: AvailabilitySliderTableProps) {
  const { t } = useLocale();
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const [browsingDate, setBrowsingDate] = useState(dayjs());
  const [viewMode, setViewMode] = useState<ViewMode>("day");
  const isPastDate = browsingDate.isBefore(dayjs(), "day");
  const { searchTerm } = useDataTable();

  // One piece of date state drives both views: the week shown is the week containing the day
  // shown, so switching views keeps your place instead of jumping back to today.
  const weekStart = useMemo(() => mondayOf(browsingDate), [browsingDate]);

  const { data, isPending, fetchNextPage, isFetching } = trpc.viewer.availability.listTeam.useInfiniteQuery(
    {
      limit: 10,
      loggedInUsersTz: CURRENT_TIMEZONE,
      startDate: browsingDate.startOf("day").toISOString(),
      endDate: browsingDate.endOf("day").toISOString(),
      searchString: searchTerm,
      oAuthClientId,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      placeholderData: keepPreviousData,
    }
  );

  //we must flatten the array of arrays from the useInfiniteQuery hook
  const flatData = useMemo(() => data?.pages?.flatMap((page) => page.rows) ?? [], [data]) as SliderUser[];

  const userIds = useMemo(() => flatData.map((user) => user.id), [flatData]);

  // The badge and the blanked "next available" column describe the rows on screen, so they are
  // derived from those rows rather than from browsingDate. keepPreviousData holds the previous
  // date's rows through the refetch, and isPending stays false throughout, so deriving them
  // from the picked date instead would label live rows as recorded history until the query
  // resolves - and strip the column header off a grid still showing today. Every row in a
  // response shares one date, so "no row is live" is exactly "this response is historical".
  const isShowingRecordedData = useMemo(
    () => flatData.length > 0 && flatData.every((user) => user.availabilitySource !== "live"),
    [flatData]
  );

  // A query of its own rather than a wider listTeam, so computing slots for the page does
  // not hold up the grid's first paint.
  const { data: nextSlots, isPending: isNextSlotsPending } = trpc.viewer.availability.nextSlots.useQuery(
    { oAuthClientId, userIds },
    // Past dates blank this column, so fetching for them is pure waste.
    { enabled: userIds.length > 0 && !isPastDate && viewMode === "day", placeholderData: keepPreviousData }
  );

  const { data: weeklyHours, isPending: isWeeklyHoursPending } =
    trpc.viewer.availability.weeklyHours.useQuery(
      {
        oAuthClientId,
        userIds,
        weekStart: weekStart.format("YYYY-MM-DD"),
        loggedInUsersTz: CURRENT_TIMEZONE,
      },
      {
        enabled: userIds.length > 0 && viewMode === "week",
        placeholderData: keepPreviousData,
      }
    );

  // Every row in a response shares one week, so one row's source answers for the table.
  const weeklySource = weeklyHours?.[String(userIds[0])]?.source;
  const isShowingRecordedWeek = viewMode === "week" && !!weeklySource && weeklySource !== "live";

  const memorisedColumns = useAvailabilityColumns({
    viewMode,
    browsingDate,
    onBrowsingDateChange: setBrowsingDate,
    nextSlots,
    isNextSlotsPending,
    isShowingRecordedData,
    weeklyHours,
    isWeeklyHoursPending,
  });

  const totalRowCount = data?.pages?.[0]?.meta?.totalRowCount ?? 0;
  const totalFetched = flatData.length;

  //called on scroll and possibly on mount to fetch more data as the user scrolls and reaches bottom of table
  const fetchMoreOnBottomReached = useCallback(
    (containerRefElement?: HTMLDivElement | null) => {
      if (containerRefElement) {
        const { scrollHeight, scrollTop, clientHeight } = containerRefElement;
        //once the user has scrolled within 300px of the bottom of the table, fetch more data if there is any
        if (scrollHeight - scrollTop - clientHeight < 300 && !isFetching && totalFetched < totalRowCount) {
          fetchNextPage();
        }
      }
    },
    [fetchNextPage, isFetching, totalFetched, totalRowCount]
  );

  useEffect(() => {
    fetchMoreOnBottomReached(tableContainerRef.current);
  }, [fetchMoreOnBottomReached]);

  const table = useReactTable({
    data: flatData,
    columns: memorisedColumns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  if (!isPending && !flatData.length) {
    return (
      <EmptyScreen
        Icon="clock"
        headline={t("no_managed_users_for_client")}
        description={t("no_managed_users_for_client_description")}
      />
    );
  }

  return (
    <TBContext.Provider
      value={createTimezoneBuddyStore({
        browsingDate: browsingDate.toDate(),
      })}>
      <CellHighlightContainer>
        <DataTable
          table={table}
          tableContainerRef={tableContainerRef}
          isPending={isPending}
          onScroll={(e) => fetchMoreOnBottomReached(e.target as HTMLDivElement)}>
          <AvailabilityViewToolbar
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            weekStart={weekStart}
            onWeekStartChange={setBrowsingDate}
            isShowingRecordedWeek={isShowingRecordedWeek}
          />
        </DataTable>
      </CellHighlightContainer>
    </TBContext.Provider>
  );
}
