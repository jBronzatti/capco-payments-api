import { Payment } from '../../domain/payment/payment';
import { PaymentNotFoundError } from '../errors';
import { PaymentRepository } from '../ports/payment-repository';

export class GetPaymentUseCase {
  constructor(private readonly payments: PaymentRepository) {}

  async execute(id: string): Promise<Payment> {
    const payment = await this.payments.findById(id);
    if (!payment) throw new PaymentNotFoundError(id);
    return payment;
  }
}
