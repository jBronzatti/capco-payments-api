import { PaymentMethod, PaymentStatus } from '../../domain/payment/payment-types';
import { Cpf } from '../../domain/shared/cpf';
import { PaymentPage, PaymentRepository } from '../ports/payment-repository';

export interface ListPaymentsQuery {
  /** Raw CPF as received, masked or not; parsed here. */
  cpf?: string;
  paymentMethod?: PaymentMethod;
  status?: PaymentStatus;
  page: number;
  limit: number;
}

export interface PaymentListing extends PaymentPage {
  page: number;
  limit: number;
}

export class ListPaymentsUseCase {
  constructor(private readonly payments: PaymentRepository) {}

  async execute(query: ListPaymentsQuery): Promise<PaymentListing> {
    const { cpf, ...filters } = query;
    const page = await this.payments.findMany({
      ...filters,
      ...(cpf === undefined ? {} : { cpf: Cpf.parse(cpf) }),
    });
    return { ...page, page: query.page, limit: query.limit };
  }
}
