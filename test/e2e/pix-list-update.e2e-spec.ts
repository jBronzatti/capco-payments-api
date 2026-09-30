import request from 'supertest';
import { App } from 'supertest/types';
import { MigratedDatabase, startMigratedPostgres } from '../support/postgres';
import { CLIENT_KEY, OPERATOR_KEY, startTestApp, TestApp } from '../support/test-app';

const PROBLEM_JSON = /^application\/problem\+json/;

describe('Listing and updating PIX payments over HTTP', () => {
  let database: MigratedDatabase;
  let testApp: TestApp;
  let server: App;

  beforeAll(async () => {
    database = await startMigratedPostgres();
    testApp = await startTestApp(database.url);
    server = testApp.app.getHttpServer();
  });

  afterAll(async () => {
    await testApp?.app.close();
    await database?.container.stop();
  });

  const create = async (cpf = '123.456.789-09', description = 'Pedido') =>
    (
      await request(server)
        .post('/api/payment')
        .set('X-API-Key', CLIENT_KEY)
        .send({ cpf, description, amount: 10, paymentMethod: 'PIX' })
        .expect(201)
    ).body as { id: string };
  const list = (query: string) => request(server).get(`/api/payment${query}`).set('X-API-Key', CLIENT_KEY);
  const put = (id: string, body: unknown, key = CLIENT_KEY) =>
    request(server)
      .put(`/api/payment/${id}`)
      .set('X-API-Key', key)
      .send(body as object);

  describe('GET /api/payment', () => {
    it('lists the newest payments first with page metadata and defaults', async () => {
      const older = await create('529.982.247-25', 'Mais antigo');
      const newer = await create('529.982.247-25', 'Mais novo');

      const response = await list('?cpf=52998224725').expect(200);

      expect(response.body.meta).toEqual({ page: 1, limit: 20, total: 2 });
      expect(response.body.data.map((p: { id: string }) => p.id)).toEqual([newer.id, older.id]);
      expect(Object.keys(response.body.data[0]).sort()).toEqual(
        ['amount', 'cpf', 'createdAt', 'description', 'id', 'paymentMethod', 'status', 'updatedAt'].sort(),
      );
    });

    it('filters by masked CPF, payment method and status together, and paginates', async () => {
      await create('111.444.777-35');
      await create('111.444.777-35');

      const firstPage = await list('?cpf=111.444.777-35&paymentMethod=PIX&status=PENDING&limit=1').expect(
        200,
      );
      const secondPage = await list('?cpf=111.444.777-35&paymentMethod=PIX&status=PENDING&limit=1&page=2');

      expect(firstPage.body.meta).toEqual({ page: 1, limit: 1, total: 2 });
      expect(secondPage.body.data).toHaveLength(1);
      expect(secondPage.body.data[0].id).not.toBe(firstPage.body.data[0].id);
    });

    it.each([
      ['a page size above 100', '?limit=1000'],
      ['a page size of zero', '?limit=0'],
      ['page zero', '?page=0'],
      ['a non-numeric page', '?page=abc'],
      ['a hexadecimal page size', '?limit=0x10'],
      ['a page in exponent notation', '?page=1e3'],
      ['a page with a sign', '?page=+5'],
      ['a repeated parameter', '?cpf=12345678909&cpf=52998224725'],
      ['an unknown parameter', '?sort=amount'],
      ['an unknown status', '?status=REFUNDED'],
      ['an injection attempt in the CPF filter', `?cpf=${encodeURIComponent("' OR 1=1--")}`],
    ])('rejects %s', async (_label, query) => {
      const response = await list(query).expect(400);

      expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
    });

    it('reports an invalid CPF filter by field', async () => {
      const response = await list('?cpf=11111111111').expect(400);

      expect(response.body.errors).toEqual([expect.objectContaining({ field: 'cpf' })]);
    });
  });

  describe('PUT /api/payment/{id}', () => {
    it('changes the description of a pending payment', async () => {
      const { id } = await create();

      const response = await put(id, { description: 'Descrição nova' }).expect(200);

      expect(response.body).toMatchObject({ id, description: 'Descrição nova', status: 'PENDING' });
    });

    it.each([
      ['an empty body', {}, 'body'],
      ['a field that cannot change', { amount: 99 }, 'amount'],
      ['a null description', { description: null }, 'description'],
      ['a status outside PAID and FAIL', { status: 'PENDING' }, 'status'],
    ])('rejects %s, naming the offending field', async (_label, body, field) => {
      const { id } = await create();

      const response = await put(id, body, OPERATOR_KEY).expect(400);

      expect(response.body.errors).toEqual([expect.objectContaining({ field })]);
    });

    it('refuses a status change from a key without the settle permission', async () => {
      const { id } = await create();

      const response = await put(id, { status: 'PAID' }).expect(403);

      expect(response.body.type).toBe('/problems/forbidden');
    });

    it('settles a PIX payment for a key with the settle permission and audits who did it', async () => {
      const { id } = await create('390.533.447-05');

      const response = await put(id, { status: 'PAID' }, OPERATOR_KEY).expect(200);

      expect(response.body.status).toBe('PAID');
      const auditLine = testApp
        .logs()
        .split('\n')
        .find((line) => line.includes('"event":"payment.status_changed"') && line.includes(id));
      expect(auditLine).toContain('"actor":"operator"');
      expect(auditLine).toContain('"from":"PENDING"');
      expect(auditLine).toContain('"to":"PAID"');
      expect(auditLine).toContain(response.headers['x-request-id']);
      expect(auditLine).not.toContain('39053344705');
    });

    it('repeats an identical PUT without writing again, and refuses to reopen a settled payment', async () => {
      const { id } = await create();
      const first = await put(id, { description: 'Falhou', status: 'FAIL' }, OPERATOR_KEY).expect(200);

      const repeated = await put(id, { description: 'Falhou', status: 'FAIL' }, OPERATOR_KEY).expect(200);
      const reopen = await put(id, { status: 'PAID' }, OPERATOR_KEY).expect(409);

      expect(repeated.body.updatedAt).toBe(first.body.updatedAt);
      expect(reopen.body.type).toBe('/problems/invalid-transition');
    });

    it('answers 400 for a malformed id and 404 for an unknown one', async () => {
      await put('not-a-uuid', { description: 'x' }).expect(400);
      await put('7d4f6a3e-2b1c-4d5e-8f90-a1b2c3d4e5f6', { description: 'x' }).expect(404);
    });
  });
});
