import { randomUUID } from 'node:crypto';
import { Payment } from '../../domain/payment/payment';
import { PaymentMethod } from '../../domain/payment/payment-types';
import { Cpf } from '../../domain/shared/cpf';
import { Description } from '../../domain/shared/description';
import { DomainValidationError } from '../../domain/shared/domain-validation.error';
import { Money } from '../../domain/shared/money';
import { CardPaymentsUnavailableError } from '../errors';
import { PaymentRepository } from '../ports/payment-repository';

export interface CreatePaymentCommand {
  cpf: string;
  description: string;
  amount: number;
  paymentMethod: PaymentMethod;
}

export interface PaymentLimits {
  maxAmountCents: number;
}

export class CreatePaymentUseCase {
  constructor(
    private readonly payments: PaymentRepository,
    private readonly limits: PaymentLimits,
  ) {}

  async execute(command: CreatePaymentCommand): Promise<Payment> {
    const payment = Payment.create(
      {
        id: randomUUID(),
        cpf: Cpf.parse(command.cpf),
        description: Description.parse(command.description),
        amount: this.amountWithinLimit(command.amount),
        paymentMethod: command.paymentMethod,
      },
      new Date(),
    );
    if (payment.paymentMethod === 'CREDIT_CARD') throw new CardPaymentsUnavailableError();
    await this.payments.insert(payment);
    return payment;
  }

  private amountWithinLimit(amount: number): Money {
    const money = Money.fromDecimal(amount);
    if (money.cents > this.limits.maxAmountCents) {
      throw new DomainValidationError('amount', 'amount exceeds the maximum allowed per payment');
    }
    return money;
  }
}
