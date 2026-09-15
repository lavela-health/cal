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
