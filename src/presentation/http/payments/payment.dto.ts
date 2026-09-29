import { IsIn, IsNumber, IsString, MaxLength } from 'class-validator';
import { PAYMENT_METHODS, PaymentMethod } from '../../../domain/payment/payment-types';

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
