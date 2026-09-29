import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import {
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  PaymentMethod,
  PaymentStatus,
  SETTLED_STATUSES,
  SettledStatus,
} from '../../../domain/payment/payment-types';

const MAX_PAGE = 10_000;
const MAX_PAGE_SIZE = 100;

/** Optional, but when the key is present its value is validated; unlike @IsOptional, null is not "absent". */
const OmittableButNotNull = () => ValidateIf((_object, value) => value !== undefined);

/**
 * Plain decimal digits only. Number() alone would also accept "0x10", "1e3", "+5" or " 5 "; anything that is
 * not digits stays a string and fails @IsInt.
 */
const DigitsToInteger = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : value,
  );

/** Shape only. Meaning (CPF check digits, cents precision, description rules) is checked by value objects. */
export class CreatePaymentDto {
  @IsString()
  @MaxLength(14)
  cpf!: string;

  @IsString()
  @MaxLength(1_000)
  description!: string;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  amount!: number;

  @IsIn(PAYMENT_METHODS)
  paymentMethod!: PaymentMethod;
}

/** PUT is a documented partial update: a nonempty subset of these two fields (checked by the use case). */
export class UpdatePaymentDto {
  @OmittableButNotNull()
  @IsString()
  @MaxLength(1_000)
  description?: string;

  @OmittableButNotNull()
  @IsIn(SETTLED_STATUSES)
  status?: SettledStatus;
}

/** Query strings arrive as text: only page and limit are converted, strictly, and nothing else is coerced. */
export class ListPaymentsQueryDto {
  @OmittableButNotNull()
  @IsString()
  @MaxLength(14)
  cpf?: string;

  @OmittableButNotNull()
  @IsIn(PAYMENT_METHODS)
  paymentMethod?: PaymentMethod;

  @OmittableButNotNull()
  @IsIn(PAYMENT_STATUSES)
  status?: PaymentStatus;

  @DigitsToInteger()
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page: number = 1;

  @DigitsToInteger()
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit: number = 20;
}
