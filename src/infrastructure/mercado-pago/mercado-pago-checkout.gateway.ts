import { MercadoPagoConfig, Preference } from 'mercadopago';
import {
  CheckoutGateway,
  CheckoutOutcomeUnknownError,
  CheckoutRejectedError,
  CheckoutSession,
} from '../../application/ports/checkout-gateway';
import { Payment } from '../../domain/payment/payment';
import { withDeadline } from '../../shared/deadline';
import { describe, isDefinitiveRefusal, isTimeout } from './provider-errors';

type PreferenceRequest = Parameters<Preference['create']>[0]['body'];
type PreferenceResponse = Awaited<ReturnType<Preference['create']>>;

export interface CheckoutGatewayOptions {
  accessToken: string;
  checkoutTtlMinutes: number;
  /** Deadline for the whole call, response body included. */
  requestTimeoutMs: number;
  clock?: () => Date;
}

// Account balance cannot be excluded (Mercado Pago docs), so settlement must still check the payment type.
const NON_CARD_PAYMENT_TYPES = ['ticket', 'bank_transfer', 'atm', 'debit_card', 'prepaid_card'];

/**
 * Checkout Pro preference creation. One attempt within one deadline: the SDK's retries are disabled because
 * Mercado Pago does not document idempotency for this endpoint. No notification_url (webhooks are configured
 * in the panel, where they are signed), no back_urls (no frontend), no payer data.
 */
export class MercadoPagoCheckoutGateway implements CheckoutGateway {
  private readonly accessToken: string;
  private readonly checkoutTtlMs: number;
  private readonly timeoutMs: number;
  private readonly clock: () => Date;

  constructor(options: CheckoutGatewayOptions) {
    this.accessToken = options.accessToken;
    this.checkoutTtlMs = options.checkoutTtlMinutes * 60_000;
    this.timeoutMs = options.requestTimeoutMs;
    this.clock = options.clock ?? (() => new Date());
  }

  async createCheckout(payment: Payment): Promise<CheckoutSession> {
    const response = await withDeadline(
      this.requestPreference(payment),
      this.timeoutMs,
      () => new CheckoutOutcomeUnknownError('Mercado Pago did not answer in time', true),
    );
    return toSession(response);
  }

  private requestPreference(payment: Payment): Promise<PreferenceResponse> {
    // A client per call: the SDK writes per-call options (such as the idempotency key) back into its config.
    const preferences = new Preference(new MercadoPagoConfig({ accessToken: this.accessToken }));
    return preferences
      .create({
        body: this.preferenceFor(payment),
        requestOptions: { timeout: this.timeoutMs, maxRetries: 0, idempotencyKey: payment.id },
      })
      .catch((error: unknown) => {
        throw isDefinitiveRefusal(error)
          ? new CheckoutRejectedError(describe(error), { cause: error })
          : new CheckoutOutcomeUnknownError(describe(error), isTimeout(error), { cause: error });
      });
  }

  private preferenceFor(payment: Payment): PreferenceRequest {
    const { id, description } = payment.toSnapshot();
    const expiresAt = new Date(this.clock().getTime() + this.checkoutTtlMs);
    return {
      items: [
        { id, title: description, quantity: 1, unit_price: payment.amount.toDecimal(), currency_id: 'BRL' },
      ],
      external_reference: id,
      expires: true,
      expiration_date_to: expiresAt.toISOString(),
      binary_mode: true,
      payment_methods: { excluded_payment_types: NON_CARD_PAYMENT_TYPES.map((type) => ({ id: type })) },
    };
  }
}

/** A 2xx without a usable HTTPS checkout is not trusted: a preference may exist, but we cannot hand it out. */
function toSession(response: {
  id?: unknown;
  init_point?: unknown;
  collector_id?: unknown;
}): CheckoutSession {
  const { id, init_point: checkoutUrl, collector_id: collectorId } = response;
  const valid =
    typeof id === 'string' &&
    typeof checkoutUrl === 'string' &&
    checkoutUrl.startsWith('https://') &&
    (typeof collectorId === 'number' || typeof collectorId === 'string');
  if (!valid) throw new CheckoutOutcomeUnknownError('Mercado Pago returned an unusable checkout', false);
  return { preferenceId: id, checkoutUrl, collectorId: String(collectorId) };
}
