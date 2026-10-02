import { UserAvatar } from "@calcom/ui/components/avatar";
import type { ColumnDef } from "@tanstack/react-table";
import type { SliderUser } from "./types";

type Translate = (key: string) => string;

/** Shared by both views so the member list reads identically whichever one is showing. */
export function buildMemberColumn(t: Translate): ColumnDef<SliderUser> {
  return {
    id: "member",
    accessorFn: (data) => data.name,
    enableHiding: false,
    enableSorting: false,
    header: "Member",
    size: 200,
    cell: ({ row }) => {
      const { username, email, timeZone, name, avatarUrl, profile } = row.original;
      return (
        <div className="flex max-w-64 shrink-0 items-center gap-2 overflow-hidden">
          <UserAvatar size="sm" user={{ username, name, avatarUrl, profile }} />
          <div className="">
            <div className="max-w-64 truncate font-medium text-emphasis text-sm" title={email}>
              {name || username || t("no_name")}
            </div>
            <div className="text-subtle text-xs leading-none">{timeZone}</div>
          </div>
        </div>
      );
    },
    filterFn: (row, _id, value) => {
      return row.original.name?.toLowerCase().includes(value.toLowerCase()) || false;
    },
  };
}
