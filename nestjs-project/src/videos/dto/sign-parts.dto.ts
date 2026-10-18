import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Max,
  Min,
} from 'class-validator';

export class SignPartsDto {
  /** Part numbers (1-based) to re-sign, e.g. after URLs expired or to resume an upload. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(10000, { each: true })
  partNumbers: number[];
}
