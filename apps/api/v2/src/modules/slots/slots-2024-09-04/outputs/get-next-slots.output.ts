import { ApiResponseWithoutData, NextSlot_2024_09_04 } from "@calcom/platform-types";
import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ValidateNested } from "class-validator";

export class GetNextSlotsOutput_2024_09_04 extends ApiResponseWithoutData {
  @ApiProperty({ type: [NextSlot_2024_09_04] })
  @ValidateNested({ each: true })
  @Type(() => NextSlot_2024_09_04)
  data!: NextSlot_2024_09_04[];
}
