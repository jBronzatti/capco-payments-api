import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaClient } from '../../src/generated/prisma/client';
import { createPrismaClient } from '../../src/infrastructure/persistence/prisma-client.factory';
import { MigratedDatabase, startMigratedPostgres } from '../support/postgres';
import { CLIENT_KEY, startTestApp, TestApp } from '../support/test-app';

const VALID_PIX = { cpf: '123.456.789-09', description: 'Pedido #123', amount: 150.75, paymentMethod: 'PIX' };
const PROBLEM_JSON = /^application\/problem\+json/;

describe('PIX payments over HTTP', () => {
  let database: MigratedDatabase;
  let prisma: PrismaClient;
  let testApp: TestApp;
  let server: App;

  beforeAll(async () => {
    database = await startMigratedPostgres();
    prisma = createPrismaClient(database.url);
    testApp = await startTestApp(database.url);
    server = testApp.app.getHttpServer();
  });

  afterAll(async () => {
    await testApp?.app.close();
    await prisma?.$disconnect();
    await database?.container.stop();
  });

  const post = (body: unknown) =>
    request(server)
      .post('/api/payment')
      .set('X-API-Key', CLIENT_KEY)
      .send(body as object);
  const postRaw = (raw: string, contentType = 'application/json') =>
    request(server)
      .post('/api/payment')
      .set('X-API-Key', CLIENT_KEY)
      .set('Content-Type', contentType)
      .send(raw);

  describe('create and retrieve', () => {
    it('creates a PIX payment as PENDING and returns its location', async () => {
      const response = await post(VALID_PIX).expect(201);

      expect(response.headers.location).toBe(`/api/payment/${response.body.id}`);
      expect(response.body).toEqual({
        id: expect.any(String),
        cpf: '12345678909',
        description: 'Pedido #123',
        amount: 150.75,
        paymentMethod: 'PIX',
        status: 'PENDING',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
    });

    it('returns the stored payment by id', async () => {
      const created = await post(VALID_PIX).expect(201);

      const response = await request(server)
        .get(`/api/payment/${created.body.id}`)
        .set('X-API-Key', CLIENT_KEY)
        .expect(200);

      expect(response.body).toEqual(created.body);
    });

    it('answers an unknown id with a problem document that does not echo the path', async () => {
      const response = await request(server)
        .get('/api/payment/7d4f6a3e-2b1c-4d5e-8f90-a1b2c3d4e5f6')
        .set('X-API-Key', CLIENT_KEY)
        .expect(404);

      expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(response.body).toEqual({
        type: '/problems/not-found',
        title: 'Payment not found',
        status: 404,
        requestId: expect.any(String),
      });
    });

    it('rejects an id that is not a UUID before touching the database', async () => {
      const response = await request(server)
        .get('/api/payment/not-a-uuid')
        .set('X-API-Key', CLIENT_KEY)
        .expect(400);

      expect(response.body).toMatchObject({
        type: '/problems/validation-error',
        errors: [{ field: 'id', message: expect.any(String) }],
      });
    });

    it('answers an unknown route with a problem document', async () => {
      const response = await request(server)
        .get('/api/nothing-here')
        .set('X-API-Key', CLIENT_KEY)
        .expect(404);

      expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(response.body.type).toBe('/problems/not-found');
    });
  });

  describe('request identity', () => {
    it('returns a server-generated request id in the header and in problem documents, ignoring the client', async () => {
      const response = await request(server)
        .get('/api/payment/7d4f6a3e-2b1c-4d5e-8f90-a1b2c3d4e5f6')
        .set('X-API-Key', CLIENT_KEY)
        .set('X-Request-Id', 'client-chosen-id')
        .expect(404);

      expect(response.headers['x-request-id']).toBe(response.body.requestId);
      expect(response.body.requestId).not.toBe('client-chosen-id');
    });
  });

  describe('authentication', () => {
    it.each([
      ['no key', undefined],
      ['a wrong key', 'definitely-not-a-valid-key'],
    ])('rejects a request with %s', async (_label, key) => {
      const call = request(server).get('/api/payment/7d4f6a3e-2b1c-4d5e-8f90-a1b2c3d4e5f6');
      const response = await (key ? call.set('X-API-Key', key) : call).expect(401);

      expect(response.body).toMatchObject({ type: '/problems/unauthorized', status: 401 });
    });
  });

  describe('input validation', () => {
    it('reports an invalid CPF by field without echoing the value', async () => {
      const response = await post({ ...VALID_PIX, cpf: '111.111.111-11' }).expect(400);

      expect(response.body.errors).toEqual([expect.objectContaining({ field: 'cpf' })]);
      expect(JSON.stringify(response.body)).not.toContain('111.111.111-11');
    });

    it('explains a missing field by its type, not by an unrelated constraint', async () => {
      const response = await post({ description: 'x', amount: 10, paymentMethod: 'PIX' }).expect(400);

      expect(response.body.errors).toEqual([
        { field: 'cpf', message: expect.stringContaining('must be a string') },
      ]);
    });

    it.each([
      ['an amount with three decimals', { ...VALID_PIX, amount: 0.001 }],
      ['an amount sent as a string', { ...VALID_PIX, amount: '10' }],
      ['an unknown payment method', { ...VALID_PIX, paymentMethod: 'BOLETO' }],
      ['a server-controlled field', { ...VALID_PIX, status: 'PAID' }],
      ['a missing field', { cpf: VALID_PIX.cpf, amount: 10, paymentMethod: 'PIX' }],
    ])('rejects %s', async (_label, body) => {
      await post(body).expect(400);
    });

    it.each(['__proto__', 'constructor', 'prototype'])('rejects a body carrying a %s key', async (key) => {
      const raw = `{"cpf":"12345678909","description":"x","amount":10,"paymentMethod":"PIX","${key}":{"polluted":true}}`;

      const response = await postRaw(raw).expect(400);

      expect(response.body.type).toBe('/problems/malformed-body');
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('rejects syntactically invalid JSON with a problem document', async () => {
      const response = await postRaw('{"cpf": ').expect(400);

      expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(response.body).toMatchObject({
        type: '/problems/malformed-body',
        requestId: expect.any(String),
      });
    });

    it('rejects a body larger than 16 kB with a problem document', async () => {
      const response = await post({ ...VALID_PIX, description: 'a'.repeat(17 * 1024) }).expect(413);

      expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(response.body).toMatchObject({
        type: '/problems/payload-too-large',
        requestId: expect.any(String),
      });
    });

    it('treats a non-JSON content type as a missing body', async () => {
      const response = await postRaw('cpf=12345678909', 'text/plain').expect(400);

      expect(response.body.type).toBe('/problems/validation-error');
    });
  });

  it('refuses card payments before writing anything while card payments are not configured', async () => {
    const before = await prisma.payment.count();

    const response = await post({ ...VALID_PIX, paymentMethod: 'CREDIT_CARD' }).expect(503);

    expect(response.body).toMatchObject({ type: '/problems/card-payments-unavailable' });
    expect(await prisma.payment.count()).toBe(before);
  });

  it('sends no-store caching and hides the framework', async () => {
    const response = await post(VALID_PIX).expect(201);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  describe('logs', () => {
    it('keep CPFs out, whether in bodies, plain or percent-encoded query strings, or paths', async () => {
      await post(VALID_PIX).expect(201);
      await request(server).get('/api/payment?cpf=12345678909').set('X-API-Key', CLIENT_KEY);
      await request(server).get('/api/payment?%63pf=12345678909').set('X-API-Key', CLIENT_KEY);
      await request(server).get('/api/payment/123.456.789-09').set('X-API-Key', CLIENT_KEY);

      const logs = testApp.logs();
      expect(logs).toContain('"queryKeys":["cpf"]');
      expect(logs).not.toMatch(/123\.?456\.?789-?09/);
    });

    it('keep valid and invalid API keys out', async () => {
      await post(VALID_PIX).expect(201);
      await request(server)
        .post('/api/payment')
        .set('X-API-Key', 'a-guessed-key-value')
        .send(VALID_PIX)
        .expect(401);

      const logs = testApp.logs();
      expect(logs).not.toContain(CLIENT_KEY);
      expect(logs).not.toContain('a-guessed-key-value');
      expect(logs).toContain('"event":"auth.failed"');
    });

    it('record requests rejected while parsing the body', async () => {
      const response = await postRaw('{"broken": ').expect(400);

      expect(testApp.logs()).toContain(`"event":"request.body_rejected"`);
      expect(testApp.logs()).toContain('"msg":"Request body rejected"');
      expect(testApp.logs()).toContain(response.body.requestId);
    });

    it('skip health probes', async () => {
      await request(server).get('/health/live').expect(200);

      expect(testApp.logs()).not.toContain('/health/live');
    });
  });

  it('reports readiness once the database answers, without an API key', async () => {
    await request(server).get('/health/ready').expect(200, { status: 'ok' });
  });
});
