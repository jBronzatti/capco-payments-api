import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../../src/generated/prisma/client';
import { Payment, PaymentSnapshot } from '../../src/domain/payment/payment';
import { createPrismaClient } from '../../src/infrastructure/persistence/prisma-client.factory';
import { PrismaPaymentRepository } from '../../src/infrastructure/persistence/prisma-payment.repository';
import { MigratedDatabase, startMigratedPostgres } from '../support/postgres';

function snapshot(overrides: Partial<PaymentSnapshot> = {}): PaymentSnapshot {
  const at = new Date('2026-09-29T12:00:00.000Z');
  return {
    id: randomUUID(),
    cpf: '12345678909',
    description: 'Pedido',
    amountCents: 15075,
    paymentMethod: 'PIX',
    status: 'PENDING',
    failureReason: null,
    providerPreferenceId: null,
    checkoutUrl: null,
    providerPaymentId: null,
    version: 0,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

describe('PrismaPaymentRepository (PostgreSQL)', () => {
  let database: MigratedDatabase;
  let prisma: PrismaClient;
  let repository: PrismaPaymentRepository;

  beforeAll(async () => {
    database = await startMigratedPostgres();
    prisma = createPrismaClient(database.url);
    repository = new PrismaPaymentRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await database?.container.stop();
  });

  beforeEach(async () => {
    await prisma.payment.deleteMany();
  });

  it('round-trips a payment without losing any field', async () => {
    const original = snapshot({
      paymentMethod: 'CREDIT_CARD',
      checkoutUrl: 'https://x',
      providerPreferenceId: 'pref-1',
    });
    await repository.insert(Payment.restore(original));

    expect((await repository.findById(original.id))?.toSnapshot()).toEqual(original);
  });

  it('returns null for an unknown id', async () => {
    expect(await repository.findById(randomUUID())).toBeNull();
  });

  it('filters, orders newest first with id as tie-breaker, and paginates', async () => {
    const early = new Date('2026-09-29T10:00:00.000Z');
    const late = new Date('2026-09-29T11:00:00.000Z');
    const rows = [
      snapshot({ id: '00000000-0000-4000-8000-000000000001', createdAt: early, updatedAt: early }),
      snapshot({ id: '00000000-0000-4000-8000-000000000002', createdAt: late, updatedAt: late }),
      snapshot({ id: '00000000-0000-4000-8000-000000000003', createdAt: late, updatedAt: late }),
      snapshot({ cpf: '52998224725', status: 'PAID' }),
      snapshot({ paymentMethod: 'CREDIT_CARD' }),
    ];
    for (const row of rows) await repository.insert(Payment.restore(row));

    const firstPage = await repository.findMany({
      cpf: '12345678909',
      paymentMethod: 'PIX',
      page: 1,
      limit: 2,
    });
    const secondPage = await repository.findMany({
      cpf: '12345678909',
      paymentMethod: 'PIX',
      page: 2,
      limit: 2,
    });

    expect(firstPage.total).toBe(3);
    expect(firstPage.items.map((p) => p.id)).toEqual([
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000002',
    ]);
    expect(secondPage.items.map((p) => p.id)).toEqual(['00000000-0000-4000-8000-000000000001']);
    expect((await repository.findMany({ status: 'PAID', page: 1, limit: 10 })).total).toBe(1);
  });

  it('updates only the given columns and bumps the version', async () => {
    const original = snapshot();
    await repository.insert(Payment.restore(original));

    const updated = await repository.update(original.id, 0, { description: 'Novo' });

    expect(updated?.toSnapshot()).toMatchObject({
      description: 'Novo',
      status: 'PENDING',
      amountCents: 15075,
      version: 1,
    });
  });

  it('refuses a write based on a stale version and leaves the row untouched', async () => {
    const original = snapshot();
    await repository.insert(Payment.restore(original));
    await repository.update(original.id, 0, { status: 'PAID', failureReason: null });

    const stale = await repository.update(original.id, 0, { status: 'FAIL', failureReason: 'MANUAL' });

    expect(stale).toBeNull();
    expect((await repository.findById(original.id))?.toSnapshot()).toMatchObject({
      status: 'PAID',
      version: 1,
    });
  });

  it('lets exactly one of two concurrent writers with the same version win', async () => {
    const original = snapshot();
    await repository.insert(Payment.restore(original));

    const results = await Promise.all([
      repository.update(original.id, 0, { status: 'PAID', failureReason: null }),
      repository.update(original.id, 0, { description: 'Concorrente' }),
    ]);

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect((await repository.findById(original.id))?.version).toBe(1);
  });

  it('enforces domain invariants in the database even if the domain were bypassed', async () => {
    const paidCardWithoutProviderPayment = snapshot({ paymentMethod: 'CREDIT_CARD', status: 'PAID' });
    const failWithoutReason = snapshot({ status: 'FAIL' });

    await expect(repository.insert(Payment.restore(paidCardWithoutProviderPayment))).rejects.toThrow();
    await expect(repository.insert(Payment.restore(failWithoutReason))).rejects.toThrow();
    await expect(repository.insert(Payment.restore(snapshot({ amountCents: 0 })))).rejects.toThrow();
  });
});
