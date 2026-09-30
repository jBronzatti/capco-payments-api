import { randomUUID } from 'node:crypto';
import http, { OutgoingHttpHeaders, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  ProviderPayment,
  ProviderUnavailableError,
} from '../../src/application/ports/provider-payment-reader';
import { PrismaClient } from '../../src/generated/prisma/client';
import { createPrismaClient } from '../../src/infrastructure/persistence/prisma-client.factory';
import { FakeCheckoutGateway, TEST_COLLECTOR_ID } from '../fakes/fake-checkout-gateway';
import { FakeProviderPaymentReader } from '../fakes/fake-provider-payment-reader';
import { SignedDelivery, signedDelivery } from '../support/mercado-pago-notification';
import { MigratedDatabase, startMigratedPostgres } from '../support/postgres';
import { CLIENT_KEY, startTestApp, TEST_CARD_ENV, TestApp } from '../support/test-app';

const CARD = {
  cpf: '123.456.789-09',
  description: 'Pedido cartão',
  amount: 150.75,
  paymentMethod: 'CREDIT_CARD',
};
const SECRET = TEST_CARD_ENV.MP_WEBHOOK_SECRET;
const PROBLEM_JSON = /^application\/problem\+json/;

let lastProviderId = 70_000;
/** payments.provider_payment_id is unique, so every test settles with its own provider payment. */
const nextProviderId = () => String((lastProviderId += 1));

function providerPayment(paymentId: string, overrides: Partial<ProviderPayment> = {}): ProviderPayment {
  return {
    id: nextProviderId(),
    status: 'approved',
    outcome: 'APPROVED',
    externalReference: paymentId,
    amountCents: 15075,
    currency: 'BRL',
    paymentType: 'credit_card',
    collectorId: TEST_COLLECTOR_ID,
    ...overrides,
  };
}

/** A plain Node request, for header shapes supertest's types do not allow, such as a header sent twice. */
async function post(
  server: Server,
  delivery: SignedDelivery,
  headers: OutgoingHttpHeaders,
): Promise<{ status: number; contentType: string | undefined; body: { errors?: unknown } }> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    return await new Promise((resolve, reject) => {
      const outgoing = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: delivery.path,
          headers: { 'content-type': 'application/json', ...headers },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString()) as { errors?: unknown };
              resolve({
                status: response.statusCode ?? 0,
                contentType: response.headers['content-type'],
                body,
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      outgoing.on('error', reject);
      outgoing.end(JSON.stringify(delivery.body));
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const logLines = (testApp: TestApp, event: string) =>
  testApp
    .logs()
    .split('\n')
    .filter((line) => line.includes(`"event":"${event}"`));

/**
 * Notifications signed the documented way, delivered over HTTP to the real wiring and a real database.
 * Mercado Pago itself is faked: automated tests never call it.
 */
describe('Mercado Pago notifications over HTTP', () => {
  let database: MigratedDatabase;
  let prisma: PrismaClient;
  const gateway = new FakeCheckoutGateway();
  const reader = new FakeProviderPaymentReader();

  beforeAll(async () => {
    database = await startMigratedPostgres();
    prisma = createPrismaClient(database.url);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await database?.container.stop();
  });

  beforeEach(() => {
    gateway.reset();
    reader.reset();
  });

  const deliver = (server: App, delivery: SignedDelivery) =>
    request(server).post(delivery.path).set(delivery.headers).send(delivery.body);

  describe('with card payments configured', () => {
    let testApp: TestApp;
    let server: App;

    beforeAll(async () => {
      testApp = await startTestApp(database.url, TEST_CARD_ENV, {
        checkoutGateway: gateway,
        paymentReader: reader,
      });
      server = testApp.app.getHttpServer();
    });

    afterAll(async () => {
      await testApp?.app.close();
    });

    const createCard = async (): Promise<string> =>
      (await request(server).post('/api/payment').set('X-API-Key', CLIENT_KEY).send(CARD).expect(201)).body
        .id;
    const statusOf = async (id: string) =>
      (await request(server).get(`/api/payment/${id}`).set('X-API-Key', CLIENT_KEY).expect(200)).body;

    it('settles a card payment from a signed notification, after reading the payment back from Mercado Pago', async () => {
      const id = await createCard();
      const payment = providerPayment(id);
      reader.willReturn(payment);

      const response = await deliver(server, signedDelivery(SECRET, payment.id));

      expect(response.status).toBe(200);
      expect(reader.requested).toEqual([payment.id]);
      expect(await statusOf(id)).toMatchObject({ status: 'PAID' });
      const audit = logLines(testApp, 'payment.status_changed').find((line) => line.includes(id));
      expect(audit).toContain('"actor":"system:mercado-pago"');
      expect(audit).toContain('"to":"PAID"');
    });

    it('acknowledges a redelivery without changing or auditing anything again', async () => {
      const id = await createCard();
      const payment = providerPayment(id);
      reader.willReturn(payment);

      await deliver(server, signedDelivery(SECRET, payment.id)).expect(200);
      await deliver(server, signedDelivery(SECRET, payment.id)).expect(200);

      expect(logLines(testApp, 'payment.status_changed').filter((line) => line.includes(id))).toHaveLength(1);
    });

    it('fails a pending card payment when Mercado Pago confirms the rejection', async () => {
      const id = await createCard();
      const payment = providerPayment(id, { status: 'rejected', outcome: 'REJECTED' });
      reader.willReturn(payment);

      await deliver(server, signedDelivery(SECRET, payment.id)).expect(200);

      expect(await statusOf(id)).toMatchObject({ status: 'FAIL', failureReason: 'PAYMENT_REJECTED' });
    });

    it('refuses a notification signed with another secret, before contacting Mercado Pago', async () => {
      const id = await createCard();
      const payment = providerPayment(id);
      reader.willReturn(payment);

      const response = await deliver(server, signedDelivery('not-the-secret', payment.id));

      expect(response.status).toBe(401);
      expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(reader.requested).toEqual([]);
      expect(await statusOf(id)).toMatchObject({ status: 'PENDING' });
      expect(logLines(testApp, 'webhook.signature_invalid')).not.toHaveLength(0);
    });

    it('refuses a notification that carries two payment ids', async () => {
      const delivery = signedDelivery(SECRET, '123');

      const response = await deliver(server, { ...delivery, path: `${delivery.path}&data.id=456` });

      expect(response.status).toBe(400);
      expect(reader.requested).toEqual([]);
      expect(logLines(testApp, 'webhook.malformed')).not.toHaveLength(0);
    });

    // Node joins most repeated headers into one value; the webhook reads them unjoined, so a second
    // x-request-id is refused as ambiguous instead of being signed over as "a, b".
    it('refuses a repeated request id sent as two real header lines', async () => {
      const delivery = signedDelivery(SECRET, '123');

      const response = await post(testApp.app.getHttpServer(), delivery, {
        'x-signature': delivery.headers['x-signature'],
        'x-request-id': [delivery.headers['x-request-id'] ?? '', 'another-request'],
      });

      expect(response.status).toBe(400);
      expect(response.contentType).toMatch(PROBLEM_JSON);
      expect(response.body.errors).toEqual([expect.objectContaining({ field: 'x-request-id' })]);
      expect(reader.requested).toEqual([]);
      expect(logLines(testApp, 'webhook.malformed')).not.toHaveLength(0);
    });

    it('refuses a notification without signature headers, before contacting Mercado Pago', async () => {
      const { path, body } = signedDelivery(SECRET, '123');

      const response = await request(server).post(path).send(body);

      expect(response.status).toBe(401);
      expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(reader.requested).toEqual([]);
    });

    it('acknowledges other topics without reading anything', async () => {
      await deliver(server, signedDelivery(SECRET, '123', { type: 'merchant_order' })).expect(200);

      expect(reader.requested).toEqual([]);
    });

    it('asks for a redelivery when Mercado Pago cannot be read', async () => {
      const id = await createCard();
      const providerId = nextProviderId();
      reader.willFail(providerId, new ProviderUnavailableError('Mercado Pago responded with status 503'));

      const response = await deliver(server, signedDelivery(SECRET, providerId));

      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ type: '/problems/notification-deferred' });
      expect(await statusOf(id)).toMatchObject({ status: 'PENDING' });
      // An expected, retryable condition: the deferral event is a warning that names the cause.
      const deferral = logLines(testApp, 'webhook.deferred').find((line) => line.includes(providerId));
      expect(deferral).toContain('"level":40');
      expect(deferral).toContain('ProviderUnavailableError');
    });

    it('surfaces a second approved payment for a paid charge, keeping the first as the settlement', async () => {
      const id = await createCard();
      const first = providerPayment(id);
      const second = providerPayment(id);
      reader.willReturn(first);
      reader.willReturn(second);
      await deliver(server, signedDelivery(SECRET, first.id)).expect(200);

      await deliver(server, signedDelivery(SECRET, second.id)).expect(200);

      expect(await prisma.payment.findUnique({ where: { id } })).toMatchObject({
        status: 'PAID',
        providerPaymentId: first.id,
      });
      const alert = logLines(testApp, 'payment.duplicate_approval').find((line) => line.includes(id));
      expect(alert).toContain('"level":50');
      expect(alert).toContain(second.id);
    });

    it('keeps an approval paid with account balance as evidence, neither settling nor rejecting the payment', async () => {
      const id = await createCard();
      const payment = providerPayment(id, { paymentType: 'account_money' });
      reader.willReturn(payment);

      await deliver(server, signedDelivery(SECRET, payment.id)).expect(200);

      expect(await statusOf(id)).toMatchObject({ status: 'PENDING' });
      expect(await prisma.providerAnomaly.findMany({ where: { paymentId: id } })).toEqual([
        expect.objectContaining({
          kind: 'MISMATCH',
          providerPaymentId: payment.id,
          mismatches: ['paymentType'],
        }),
      ]);
      expect(logLines(testApp, 'payment.provider_mismatch').find((line) => line.includes(id))).toBeDefined();
    });

    it('records a provider payment that is not one of ours, and acknowledges it', async () => {
      const payment = providerPayment(randomUUID());
      reader.willReturn(payment);

      await deliver(server, signedDelivery(SECRET, payment.id)).expect(200);

      expect(await prisma.providerAnomaly.findMany({ where: { providerPaymentId: payment.id } })).toEqual([
        expect.objectContaining({ kind: 'UNKNOWN_REFERENCE', paymentId: null }),
      ]);
    });

    it('does not open the payment API to notification callers', async () => {
      await request(server).get(`/api/payment/${randomUUID()}`).expect(401);
    });

    it('never writes the configured secrets or the CPF to logs or error responses', async () => {
      const id = await createCard();
      const payment = providerPayment(id);
      const unreadable = nextProviderId();
      reader.willReturn(payment);
      reader.willFail(unreadable, new ProviderUnavailableError('Mercado Pago responded with status 503'));
      const errors = await Promise.all([
        request(server).get('/api/payment?cpf=123.456.789-09').set('X-API-Key', 'wrong-key'),
        request(server)
          .post('/api/payment')
          .set('X-API-Key', CLIENT_KEY)
          .send({ ...CARD, amount: 0 }),
        deliver(server, signedDelivery('not-the-secret', payment.id)),
        deliver(server, signedDelivery(SECRET, unreadable)),
      ]);
      await request(server).get('/api/payment?cpf=12345678909').set('X-API-Key', CLIENT_KEY).expect(200);
      await deliver(server, signedDelivery(SECRET, payment.id)).expect(200);

      expect(errors.map((response) => response.status)).toEqual([401, 400, 401, 503]);
      const exposed = [testApp.logs(), ...errors.map((response) => response.text)].join('\n');
      for (const secret of [CLIENT_KEY, TEST_CARD_ENV.MP_ACCESS_TOKEN, SECRET]) {
        expect(exposed).not.toContain(secret);
      }
      expect(exposed).not.toMatch(/123\.?456\.?789-?09/);
    });
  });

  it('answers 503 when card payments are not configured', async () => {
    const testApp = await startTestApp(database.url, {}, { paymentReader: reader });
    try {
      const response = await deliver(testApp.app.getHttpServer(), signedDelivery(SECRET, '123'));

      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ type: '/problems/card-payments-unavailable' });
      expect(reader.requested).toEqual([]);
    } finally {
      await testApp.app.close();
    }
  });

  it('turns away a source after repeated rejected notifications, but never a correctly signed one', async () => {
    const testApp = await startTestApp(database.url, TEST_CARD_ENV, {
      paymentReader: reader,
      webhookLimits: { failuresPerMinute: 2 },
    });
    try {
      const server = testApp.app.getHttpServer();
      await deliver(server, signedDelivery('forged', '123')).expect(401);
      await deliver(server, signedDelivery('forged', '123')).expect(401);

      const forged = await deliver(server, signedDelivery('forged', '123'));
      const genuine = await deliver(server, signedDelivery(SECRET, '123', { type: 'merchant_order' }));

      expect(forged.status).toBe(429);
      expect(genuine.status).toBe(200);
      expect(logLines(testApp, 'webhook.signature_invalid')).toHaveLength(2);
    } finally {
      await testApp.app.close();
    }
  });

  it('answers 503 at its deadline, and keeps counting stalled work against the concurrency cap', async () => {
    const testApp = await startTestApp(database.url, TEST_CARD_ENV, {
      paymentReader: reader,
      webhookLimits: { deadlineMs: 300, maxConcurrentSettlements: 1 },
    });
    try {
      const server = testApp.app.getHttpServer();
      reader.willHang('801');
      reader.willReturn(providerPayment(randomUUID(), { id: '802' }));
      const startedAt = Date.now();

      const stalled = await deliver(server, signedDelivery(SECRET, '801'));
      const next = await deliver(server, signedDelivery(SECRET, '802'));

      expect(stalled.status).toBe(503);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(next.status).toBe(503);
      expect(reader.requested).toEqual(['801']);
    } finally {
      await testApp.app.close();
    }
  });
});
