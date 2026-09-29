import request from 'supertest';
import { App } from 'supertest/types';
import {
  CheckoutOutcomeUnknownError,
  CheckoutRejectedError,
} from '../../src/application/ports/checkout-gateway';
import { FakeCheckoutGateway } from '../fakes/fake-checkout-gateway';
import { MigratedDatabase, startMigratedPostgres } from '../support/postgres';
import { CLIENT_KEY, OPERATOR_KEY, startTestApp, TEST_CARD_ENV, TestApp } from '../support/test-app';

const CARD = {
  cpf: '123.456.789-09',
  description: 'Pedido cartão',
  amount: 150.75,
  paymentMethod: 'CREDIT_CARD',
};
const PROBLEM_JSON = /^application\/problem\+json/;

/** Card payments over HTTP with the provider faked: automated tests never call Mercado Pago. */
describe('Card checkout over HTTP', () => {
  let database: MigratedDatabase;
  let testApp: TestApp;
  let server: App;
  const gateway = new FakeCheckoutGateway();

  beforeAll(async () => {
    database = await startMigratedPostgres();
    testApp = await startTestApp(database.url, TEST_CARD_ENV, { checkoutGateway: gateway });
    server = testApp.app.getHttpServer();
  });

  afterAll(async () => {
    await testApp?.app.close();
    await database?.container.stop();
  });

  beforeEach(() => gateway.reset());

  const create = () => request(server).post('/api/payment').set('X-API-Key', CLIENT_KEY).send(CARD);
  const get = (id: string) => request(server).get(`/api/payment/${id}`).set('X-API-Key', CLIENT_KEY);

  it('creates a card payment and hands back the checkout URL', async () => {
    const response = await create().expect(201);

    expect(response.body).toMatchObject({
      paymentMethod: 'CREDIT_CARD',
      status: 'PENDING',
      checkoutUrl: `https://checkout.example/${response.body.id}`,
    });
    expect((await get(response.body.id).expect(200)).body.checkoutUrl).toBe(response.body.checkoutUrl);
  });

  it('answers 502 with the payment id when the provider rejects the checkout, recording FAIL', async () => {
    gateway.willAnswer(async () => {
      throw new CheckoutRejectedError('Mercado Pago responded with status 400');
    });

    const response = await create().expect(502);

    expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(response.body).toMatchObject({ type: '/problems/checkout-failed', paymentId: expect.any(String) });
    expect((await get(response.body.paymentId).expect(200)).body).toMatchObject({
      status: 'FAIL',
      failureReason: 'CHECKOUT_FAILED',
    });
  });

  it('answers 504 with the payment id when the provider times out, recording an unknown outcome', async () => {
    gateway.willAnswer(async () => {
      throw new CheckoutOutcomeUnknownError('timed out', true);
    });

    const response = await create().expect(504);

    expect(response.body).toMatchObject({
      type: '/problems/checkout-outcome-unknown',
      paymentId: expect.any(String),
    });
    expect((await get(response.body.paymentId).expect(200)).body).toMatchObject({
      status: 'FAIL',
      failureReason: 'CHECKOUT_OUTCOME_UNKNOWN',
    });
  });

  it('answers 502 for other unknown outcomes', async () => {
    gateway.willAnswer(async () => {
      throw new CheckoutOutcomeUnknownError('Mercado Pago responded with status 503', false);
    });

    const response = await create().expect(502);

    expect(response.body.type).toBe('/problems/checkout-outcome-unknown');
  });

  it('refuses a manual status change on a card payment, even with the settle permission', async () => {
    const { body } = await create().expect(201);

    const response = await request(server)
      .put(`/api/payment/${body.id}`)
      .set('X-API-Key', OPERATOR_KEY)
      .send({ status: 'PAID' })
      .expect(409);

    expect(response.body.type).toBe('/problems/status-managed-by-provider');
  });

  it('does not log the CPF during a card checkout, masked or not', async () => {
    await create().expect(201);

    expect(gateway.calls).toHaveLength(1);
    expect(testApp.logs()).not.toMatch(/123\.?456\.?789-?09/);
  });
});
