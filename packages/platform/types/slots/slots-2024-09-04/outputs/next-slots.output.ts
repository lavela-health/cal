import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";

export class NextSlotUser_2024_09_04 {
  @ApiProperty({ description: "ID of the user who owns the event type." })
  @IsInt()
  id!: number;

  @ApiProperty({ description: "Username of the user who owns the event type.", nullable: true })
  @IsString()
  username!: string | null;

  @ApiProperty({ description: "Name of the user who owns the event type.", nullable: true })
  @IsString()
  name!: string | null;
}

export class NextSlotBase_2024_09_04 {
  @ApiProperty({ description: "Start time of the slot." })
  @IsDateString()
  start!: string;

  @ApiProperty({ description: "End time of the slot." })
  @IsDateString()
  end!: string;

  @ApiProperty({ description: "Duration of the slot in minutes." })
  @IsInt()
  duration!: number;

  @ApiProperty({ description: "ID of the event type this slot belongs to." })
  @IsInt()
  eventTypeId!: number;

  @ApiProperty({ description: "Slug of the event type this slot belongs to." })
  @IsString()
  eventTypeSlug!: string;
}

export class NextSlot_2024_09_04 extends NextSlotBase_2024_09_04 {
  @ApiPropertyOptional({
    type: NextSlotUser_2024_09_04,
    description: "The user this slot is bookable with. Only returned by the OAuth client endpoint.",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => NextSlotUser_2024_09_04)
  user?: NextSlotUser_2024_09_04;
}

export class NextSlotsForUser_2024_09_04 {
  @ApiProperty({ type: NextSlotUser_2024_09_04, description: "The user these slots are bookable with." })
  @ValidateNested()
  @Type(() => NextSlotUser_2024_09_04)
  user!: NextSlotUser_2024_09_04;

  @ApiProperty({
    type: [NextSlotBase_2024_09_04],
    description:
      "This user's soonest slots, ascending by start. Empty means the search found nothing within 'maxHorizonDays'.",
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NextSlotBase_2024_09_04)
  slots!: NextSlotBase_2024_09_04[];

  @ApiProperty({
    description:
      "True when every one of this user's event types failed to be searched, so an empty 'slots' asserts nothing about their availability. Callers that render 'fully booked' should show nothing instead.",
    example: false,
  })
  @IsBoolean()
  searchFailed!: boolean;
}
