import { Payment } from '../../../domain/payment/payment';
import { FailureReason, PaymentMethod, PaymentStatus } from '../../../domain/payment/payment-types';

export interface PaymentResponse {
  id: string;
  cpf: string;
  description: string;
  amount: number;
  paymentMethod: PaymentMethod;
  status: PaymentStatus;
  failureReason?: FailureReason;
  checkoutUrl?: string;
  createdAt: string;
  updatedAt: string;
}

/** Explicit field selection: provider identifiers and the version stay internal. */
export function presentPayment(payment: Payment): PaymentResponse {
  const state = payment.toSnapshot();
  return {
    id: state.id,
    cpf: state.cpf,
    description: state.description,
    amount: payment.amount.toDecimal(),
    paymentMethod: state.paymentMethod,
    status: state.status,
    ...(state.status === 'FAIL' && state.failureReason ? { failureReason: state.failureReason } : {}),
    ...(state.status === 'PENDING' && state.checkoutUrl ? { checkoutUrl: state.checkoutUrl } : {}),
    createdAt: state.createdAt.toISOString(),
    updatedAt: state.updatedAt.toISOString(),
  };
}
