import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsArray, IsDateString, IsInt, IsNumber, IsOptional, IsString, Max, Min } from "class-validator";

class NextSlotsSearchInput {
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
      "How far into the future to search before giving up. Fewer slots than asked for means this horizon held no more.",
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

class NextSlotsBaseInput extends NextSlotsSearchInput {
  @ApiProperty({ description: "How many slots to return.", example: 5, minimum: 1, maximum: 50 })
  @Transform(({ value }: { value: string }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  @Max(50)
  limit!: number;
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

export class GetClientNextSlotsPerUserInput_2024_09_04 extends NextSlotsSearchInput {
  @ApiPropertyOptional({
    type: [Number],
    description:
      "Restrict the search to these managed user IDs, repeated or comma-separated. Defaults to every managed user of the client. Bounding the search here avoids paying for users the caller will not render.",
    example: [412, 518],
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value === "string") {
      return value.split(",").map((id: string) => parseInt(id.trim(), 10));
    }
    if (Array.isArray(value)) {
      return value.map((id) => (typeof id === "string" ? parseInt(id, 10) : id));
    }
    return value;
  })
  @IsArray()
  @IsNumber({}, { each: true })
  userIds?: number[];

  @ApiPropertyOptional({
    description:
      "Restrict the search to each managed user's event type with this slug. Defaults to every bookable event type they own.",
    example: "intro",
  })
  @IsOptional()
  @IsString()
  eventTypeSlug?: string;

  @ApiPropertyOptional({
    description: "How many slots to return per user.",
    example: 1,
    minimum: 1,
    maximum: 10,
    default: 1,
  })
  @IsOptional()
  @Transform(({ value }: { value: string }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  @Max(10)
  slotsPerUser?: number;
}
