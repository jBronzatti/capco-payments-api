import { ProviderUnavailableError } from '../../../src/application/ports/provider-payment-reader';
import { MercadoPagoPaymentReader } from '../../../src/infrastructure/mercado-pago/mercado-pago-payment.reader';

const TOKEN = 'TEST-fake-access-token';
const REFERENCE = '0b7c8f0e-6a0e-4a53-9a57-0d7d9e0c1a11';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const mpPayment = (overrides: Record<string, unknown> = {}) => ({
  id: 9001,
  status: 'approved',
  status_detail: 'accredited',
  external_reference: REFERENCE,
  transaction_amount: 150.75,
  currency_id: 'BRL',
  payment_type_id: 'credit_card',
  collector_id: 111222333,
  live_mode: false,
  payer: { email: 'buyer@example.com', identification: { type: 'CPF', number: '12345678909' } },
  ...overrides,
});

/** Narrow transport mock: the real SDK runs, only the network call is replaced. */
describe('MercadoPagoPaymentReader', () => {
  let fetchMock: jest.SpyInstance;
  const reader = new MercadoPagoPaymentReader({ accessToken: TOKEN, requestTimeoutMs: 200 });

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => fetchMock.mockRestore());

  it('reads the payment by id with our access token, in a single attempt', async () => {
    fetchMock.mockResolvedValue(json(200, mpPayment()));

    await reader.getPayment('9001');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.mercadopago.com/v1/payments/9001');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps only the facts settlement binds on, never payer data', async () => {
    fetchMock.mockResolvedValue(json(200, mpPayment()));

    const payment = await reader.getPayment('9001');

    expect(payment).toEqual({
      id: '9001',
      status: 'approved',
      outcome: 'APPROVED',
      externalReference: REFERENCE,
      amountCents: 15075,
      currency: 'BRL',
      paymentType: 'credit_card',
      collectorId: '111222333',
    });
  });

  it.each([
    ['approved', 'APPROVED'],
    ['rejected', 'REJECTED'],
    ['cancelled', 'REJECTED'],
    ['refunded', 'REVERSED'],
    ['charged_back', 'REVERSED'],
    ['pending', 'IN_PROGRESS'],
    ['in_process', 'IN_PROGRESS'],
    ['authorized', 'IN_PROGRESS'],
    ['in_mediation', 'IN_PROGRESS'],
    ['a_status_added_later', 'UNRECOGNIZED'],
    ['constructor', 'UNRECOGNIZED'],
  ])('reads status %p as %p, keeping the raw status as evidence', async (status, outcome) => {
    fetchMock.mockResolvedValue(json(200, mpPayment({ status })));

    await expect(reader.getPayment('9001')).resolves.toMatchObject({ status, outcome });
  });

  it.each([
    ['more than two decimals', 150.755],
    ['zero', 0],
    ['a negative amount', -150.75],
    ['a string', '150.75'],
    ['no amount', undefined],
  ])('never rounds an amount into a match: %s reads as no exact amount', async (_label, amount) => {
    fetchMock.mockResolvedValue(json(200, mpPayment({ transaction_amount: amount })));

    await expect(reader.getPayment('9001')).resolves.toMatchObject({ amountCents: null });
  });

  it('reads the owning account whether Mercado Pago sends it as a number or as text', async () => {
    fetchMock.mockResolvedValue(json(200, mpPayment({ collector_id: '111222333' })));

    await expect(reader.getPayment('9001')).resolves.toMatchObject({ collectorId: '111222333' });
  });

  it('reads absent optional facts as null', async () => {
    fetchMock.mockResolvedValue(json(200, { id: 9001, status: 'approved', transaction_amount: 150.75 }));

    await expect(reader.getPayment('9001')).resolves.toMatchObject({
      externalReference: null,
      currency: null,
      paymentType: null,
      collectorId: null,
    });
  });

  // 404 included: a just-created payment may not be readable yet, so the notification must be redelivered.
  it.each([401, 404, 429, 500, 503])(
    'reports HTTP %p as the provider being unavailable, with the SDK error as cause',
    async (status) => {
      fetchMock.mockResolvedValue(json(status, { message: 'nope', error: 'error', status }));

      const attempt = reader.getPayment('9001');

      await expect(attempt).rejects.toThrow(ProviderUnavailableError);
      await expect(attempt).rejects.toMatchObject({ cause: expect.objectContaining({ status }) });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('gives up at the deadline, including a response body that stalls after the headers', async () => {
    const stalledBody = new ReadableStream({ start: () => undefined });
    fetchMock.mockResolvedValue(
      new Response(stalledBody, { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const startedAt = Date.now();

    await expect(reader.getPayment('9001')).rejects.toThrow(ProviderUnavailableError);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it.each([
    ['a different payment', mpPayment({ id: 9002 })],
    ['a payment without a status', mpPayment({ status: undefined })],
    ['a payment without an id', mpPayment({ id: undefined })],
    ['an id hidden in an array', mpPayment({ id: [9001] })],
  ])('does not trust a success response carrying %s', async (_label, body) => {
    fetchMock.mockResolvedValue(json(200, body));

    await expect(reader.getPayment('9001')).rejects.toThrow(ProviderUnavailableError);
  });
});
