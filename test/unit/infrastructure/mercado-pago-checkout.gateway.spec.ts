import {
  CheckoutOutcomeUnknownError,
  CheckoutRejectedError,
} from '../../../src/application/ports/checkout-gateway';
import { Payment } from '../../../src/domain/payment/payment';
import { MercadoPagoCheckoutGateway } from '../../../src/infrastructure/mercado-pago/mercado-pago-checkout.gateway';

const TOKEN = 'TEST-fake-access-token';
const NOW = new Date('2026-09-29T12:00:00.000Z');

const payment = Payment.restore({
  id: '0b7c8f0e-6a0e-4a53-9a57-0d7d9e0c1a11',
  cpf: '12345678909',
  description: 'Pedido cartão',
  amountCents: 1999,
  paymentMethod: 'CREDIT_CARD',
  status: 'PENDING',
  failureReason: null,
  providerPreferenceId: null,
  checkoutUrl: null,
  providerPaymentId: null,
  version: 0,
  createdAt: NOW,
  updatedAt: NOW,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Narrow transport mock: the real SDK runs, only the network call is replaced. */
describe('MercadoPagoCheckoutGateway', () => {
  let fetchMock: jest.SpyInstance;
  const gateway = new MercadoPagoCheckoutGateway({
    accessToken: TOKEN,
    checkoutTtlMinutes: 30,
    requestTimeoutMs: 200,
    clock: () => NOW,
  });

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => fetchMock.mockRestore());

  const sentRequest = () => {
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return { url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> };
  };

  it('creates a preference bound to our payment, with no personal data and no callback URLs', async () => {
    fetchMock.mockResolvedValue(
      json(201, {
        id: 'pref-1',
        init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-1',
        collector_id: 111222333,
      }),
    );

    await gateway.createCheckout(payment);

    const { url, init, body } = sentRequest();
    expect(url).toBe('https://api.mercadopago.com/checkout/preferences/');
    expect(init.method).toBe('POST');
    expect(body).toEqual({
      items: [{ id: payment.id, title: 'Pedido cartão', quantity: 1, unit_price: 19.99, currency_id: 'BRL' }],
      external_reference: payment.id,
      expires: true,
      expiration_date_to: '2026-09-29T12:30:00.000Z',
      binary_mode: true,
      payment_methods: {
        excluded_payment_types: [
          { id: 'ticket' },
          { id: 'bank_transfer' },
          { id: 'atm' },
          { id: 'debit_card' },
          { id: 'prepaid_card' },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toContain('12345678909');
  });

  it('authenticates with the access token and uses the payment id as idempotency key', async () => {
    fetchMock.mockResolvedValue(
      json(201, { id: 'pref-1', init_point: 'https://x.example/p', collector_id: 1 }),
    );

    await gateway.createCheckout(payment);

    const headers = sentRequest().init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['X-Idempotency-Key']).toBe(payment.id);
  });

  it('returns the checkout session, including the owning account', async () => {
    fetchMock.mockResolvedValue(
      json(201, { id: 'pref-1', init_point: 'https://checkout.example/pref-1', collector_id: 111222333 }),
    );

    await expect(gateway.createCheckout(payment)).resolves.toEqual({
      preferenceId: 'pref-1',
      checkoutUrl: 'https://checkout.example/pref-1',
      collectorId: '111222333',
    });
  });

  it.each([400, 401, 403, 404])(
    'treats HTTP %p as a definitive rejection, keeping the SDK error as cause',
    async (status) => {
      fetchMock.mockResolvedValue(json(status, { message: 'rejected', error: 'bad_request', status }));

      const attempt = gateway.createCheckout(payment);

      await expect(attempt).rejects.toThrow(CheckoutRejectedError);
      await expect(attempt).rejects.toMatchObject({ cause: expect.objectContaining({ status }) });
    },
  );

  // 409 (idempotency conflict), 423 and 424 do not prove that no preference exists.
  it.each([408, 409, 423, 424, 429, 500, 502, 503])(
    'treats HTTP %p as an unknown outcome, calling the provider exactly once',
    async (status) => {
      fetchMock.mockResolvedValue(json(status, { message: 'unavailable', error: 'server_error', status }));

      await expect(gateway.createCheckout(payment)).rejects.toMatchObject({
        name: 'CheckoutOutcomeUnknownError',
        timedOut: false,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('gives up after the configured timeout and reports it as an unknown outcome', async () => {
    // Like real fetch: an aborted request rejects with the signal's reason.
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    );

    await expect(gateway.createCheckout(payment)).rejects.toMatchObject({
      name: 'CheckoutOutcomeUnknownError',
      timedOut: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds the whole call, including a response body that stalls after the headers', async () => {
    const stalledBody = new ReadableStream({ start: () => undefined });
    fetchMock.mockResolvedValue(
      new Response(stalledBody, { status: 201, headers: { 'Content-Type': 'application/json' } }),
    );
    const startedAt = Date.now();

    await expect(gateway.createCheckout(payment)).rejects.toMatchObject({
      name: 'CheckoutOutcomeUnknownError',
      timedOut: true,
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('reports a network failure as an unknown outcome that did not time out', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(gateway.createCheckout(payment)).rejects.toMatchObject({
      name: 'CheckoutOutcomeUnknownError',
      timedOut: false,
    });
  });

  it('treats a success response without a usable checkout as an unknown outcome', async () => {
    fetchMock.mockResolvedValue(json(201, { id: 'pref-1' }));

    await expect(gateway.createCheckout(payment)).rejects.toThrow(CheckoutOutcomeUnknownError);
  });

  it('refuses a checkout URL that is not HTTPS', async () => {
    fetchMock.mockResolvedValue(
      json(201, { id: 'pref-1', init_point: 'javascript:alert(1)', collector_id: 1 }),
    );

    await expect(gateway.createCheckout(payment)).rejects.toThrow(CheckoutOutcomeUnknownError);
  });
});
