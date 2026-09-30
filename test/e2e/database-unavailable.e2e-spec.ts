import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { FakeCheckoutGateway, TEST_COLLECTOR_ID } from '../fakes/fake-checkout-gateway';
import { FakeProviderPaymentReader } from '../fakes/fake-provider-payment-reader';
import { signedDelivery } from '../support/mercado-pago-notification';
import { CLIENT_KEY, startTestApp, TEST_CARD_ENV, TestApp } from '../support/test-app';

const PROBLEM_JSON = /^application\/problem\+json/;

/**
 * The database is down (nothing listens on the configured port). Every answer must be a safe problem document,
 * nothing may reach the provider before the local record exists, and no notification may be acknowledged.
 */
describe('With the database unreachable', () => {
  const password = randomBytes(12).toString('hex');
  const databaseUrl = `postgresql://payments:${password}@127.0.0.1:1/payments`;
  const gateway = new FakeCheckoutGateway();
  const reader = new FakeProviderPaymentReader();
  let testApp: TestApp;
  let server: App;

  beforeAll(async () => {
    testApp = await startTestApp(databaseUrl, TEST_CARD_ENV, {
      checkoutGateway: gateway,
      paymentReader: reader,
    });
    server = testApp.app.getHttpServer();
  });

  afterAll(async () => {
    await testApp?.app.close();
  });

  const create = (paymentMethod: string) =>
    request(server)
      .post('/api/payment')
      .set('X-API-Key', CLIENT_KEY)
      .send({ cpf: '123.456.789-09', description: 'Pedido', amount: 10, paymentMethod });

  it('reports not ready', async () => {
    const response = await request(server).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
  });

  it('fails a PIX creation with a generic server error that reveals nothing about the database', async () => {
    const response = await create('PIX');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      type: '/problems/internal',
      title: 'Internal server error',
      status: 500,
      requestId: expect.any(String),
    });
  });

  it('never asks the provider for a checkout when the payment could not be recorded first', async () => {
    const response = await create('CREDIT_CARD');

    expect(response.status).toBe(500);
    expect(gateway.calls).toHaveLength(0);
  });

  it('never acknowledges a notification it could not settle', async () => {
    reader.willReturn({
      id: '7001',
      status: 'approved',
      outcome: 'APPROVED',
      externalReference: '0b7c8f0e-6a0e-4a53-9a57-0d7d9e0c1a11',
      amountCents: 1000,
      currency: 'BRL',
      paymentType: 'credit_card',
      collectorId: TEST_COLLECTOR_ID,
    });
    const delivery = signedDelivery(TEST_CARD_ENV.MP_WEBHOOK_SECRET, '7001');

    const response = await request(server).post(delivery.path).set(delivery.headers).send(delivery.body);

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ type: '/problems/notification-deferred' });
  });

  it('keeps the database credentials and address out of responses and logs', async () => {
    const responses = await Promise.all([create('PIX'), request(server).get('/health/ready')]);

    const exposed = [testApp.logs(), ...responses.map((response) => response.text)].join('\n');
    expect(exposed).not.toContain(password);
    expect(exposed).not.toMatch(/127\.0\.0\.1:1(?!\d)/);
    expect(exposed).not.toContain(databaseUrl);
  });
});
