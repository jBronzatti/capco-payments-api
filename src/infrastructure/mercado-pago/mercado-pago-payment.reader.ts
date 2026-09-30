import { MercadoPagoConfig, Payment } from 'mercadopago';
import {
  ProviderPayment,
  ProviderPaymentReader,
  ProviderUnavailableError,
} from '../../application/ports/provider-payment-reader';
import { ProviderOutcome } from '../../domain/payment/payment-types';
import { Money } from '../../domain/shared/money';
import { withDeadline } from '../../shared/deadline';
import { describe } from './provider-errors';

type PaymentResponse = Awaited<ReturnType<Payment['get']>>;

export interface PaymentReaderOptions {
  accessToken: string;
  /** Deadline for the whole call, response body included. */
  requestTimeoutMs: number;
}

// Statuses outside this table (including ones Mercado Pago adds later) are UNRECOGNIZED and change nothing.
const OUTCOMES = new Map<string, ProviderOutcome>([
  ['approved', 'APPROVED'],
  ['rejected', 'REJECTED'],
  ['cancelled', 'REJECTED'],
  ['refunded', 'REVERSED'],
  ['charged_back', 'REVERSED'],
  ['pending', 'IN_PROGRESS'],
  ['in_process', 'IN_PROGRESS'],
  ['authorized', 'IN_PROGRESS'],
  ['in_mediation', 'IN_PROGRESS'],
]);

/**
 * Reads a payment back from Mercado Pago, the source of truth for its status. One attempt within one deadline;
 * any failure, a 404 included (a new payment may not be readable yet), means the notification must be retried.
 */
export class MercadoPagoPaymentReader implements ProviderPaymentReader {
  constructor(private readonly options: PaymentReaderOptions) {}

  async getPayment(providerPaymentId: string): Promise<ProviderPayment> {
    const response = await withDeadline(
      this.request(providerPaymentId),
      this.options.requestTimeoutMs,
      () => new ProviderUnavailableError('Mercado Pago did not answer in time'),
    );
    return toProviderPayment(providerPaymentId, response);
  }

  private request(id: string): Promise<PaymentResponse> {
    const payments = new Payment(new MercadoPagoConfig({ accessToken: this.options.accessToken }));
    return payments
      .get({ id, requestOptions: { timeout: this.options.requestTimeoutMs, maxRetries: 0 } })
      .catch((error: unknown) => {
        throw new ProviderUnavailableError(describe(error), { cause: error });
      });
  }
}

/** Payer data and everything else in the response is dropped here. */
function toProviderPayment(requestedId: string, response: PaymentResponse): ProviderPayment {
  const { status } = response;
  if (identifier(response.id) !== requestedId || typeof status !== 'string') {
    throw new ProviderUnavailableError('Mercado Pago returned an unusable payment');
  }
  return {
    id: requestedId,
    status,
    outcome: OUTCOMES.get(status) ?? 'UNRECOGNIZED',
    externalReference: text(response.external_reference),
    amountCents: exactCents(response.transaction_amount),
    currency: text(response.currency_id),
    paymentType: text(response.payment_type_id),
    collectorId: identifier(response.collector_id),
  };
}

/** The SDK types describe the documented response, not what arrives; a wrong type reads as absent. */
function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Ids arrive as numbers today; text is accepted too, anything else (an array, an object) is not an id. */
function identifier(value: unknown): string | null {
  if (typeof value === 'number') return String(value);
  return text(value);
}

function exactCents(amount: unknown): number | null {
  if (typeof amount !== 'number') return null;
  try {
    return Money.fromDecimal(amount).cents;
  } catch {
    return null;
  }
}
