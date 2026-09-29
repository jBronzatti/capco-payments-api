import { randomUUID } from 'node:crypto';
import { UpdatePaymentUseCase } from '../../src/application/use-cases/update-payment.use-case';
import { InvalidTransitionError } from '../../src/domain/payment/errors';
import { Payment } from '../../src/domain/payment/payment';
import { PrismaClient } from '../../src/generated/prisma/client';
import { createPrismaClient } from '../../src/infrastructure/persistence/prisma-client.factory';
import { PrismaPaymentRepository } from '../../src/infrastructure/persistence/prisma-payment.repository';
import { RecordingAuditLog } from '../fakes/recording-audit-log';
import { GatedRepository } from '../support/gated-repository';
import { MigratedDatabase, startMigratedPostgres } from '../support/postgres';

describe('Concurrent updates against PostgreSQL: a stale edit can never revert a settlement', () => {
  const SETTLER = { id: 'operator', canSettle: true };
  const CLIENT = { id: 'client', canSettle: false };
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

  async function pendingPix(): Promise<string> {
    const id = randomUUID();
    const at = new Date();
    await repository.insert(
      Payment.restore({
        id,
        cpf: '12345678909',
        description: 'Original',
        amountCents: 1000,
        paymentMethod: 'PIX',
        status: 'PENDING',
        failureReason: null,
        providerPreferenceId: null,
        checkoutUrl: null,
        providerPaymentId: null,
        version: 0,
        createdAt: at,
        updatedAt: at,
      }),
    );
    return id;
  }

  it('a description update that read before a settlement is re-evaluated and refused', async () => {
    const id = await pendingPix();
    const gated = new GatedRepository(repository);
    const audit = new RecordingAuditLog();
    const staleEdit = new UpdatePaymentUseCase(gated, audit).execute({
      id,
      description: 'Tarde',
      actor: CLIENT,
    });
    await gated.writeReached;

    await new UpdatePaymentUseCase(repository, audit).execute({ id, status: 'PAID', actor: SETTLER });
    gated.release();

    await expect(staleEdit).rejects.toThrow(InvalidTransitionError);
    expect(gated.reads).toBe(2);
    expect(await prisma.payment.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'PAID',
      description: 'Original',
      version: 1,
    });
    expect(audit.records).toHaveLength(1);
  });

  it('a settlement that read before a description update retries, settles once and keeps the description', async () => {
    const id = await pendingPix();
    const gated = new GatedRepository(repository);
    const audit = new RecordingAuditLog();
    const settlement = new UpdatePaymentUseCase(gated, audit).execute({ id, status: 'PAID', actor: SETTLER });
    await gated.writeReached;

    await new UpdatePaymentUseCase(repository, audit).execute({ id, description: 'Primeiro', actor: CLIENT });
    gated.release();

    await expect(settlement).resolves.toBeDefined();
    expect(gated.reads).toBe(2);
    expect(await prisma.payment.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'PAID',
      description: 'Primeiro',
      version: 2,
    });
    expect(audit.records).toEqual([{ paymentId: id, from: 'PENDING', to: 'PAID', actor: 'operator' }]);
  });

  it('never ends up PENDING when both race freely, over many rounds', async () => {
    const useCase = new UpdatePaymentUseCase(repository, new RecordingAuditLog());
    for (let round = 0; round < 25; round += 1) {
      const id = await pendingPix();

      await Promise.allSettled([
        useCase.execute({ id, description: `Corrida ${round}`, actor: CLIENT }),
        useCase.execute({ id, status: 'PAID', actor: SETTLER }),
      ]);

      expect((await prisma.payment.findUniqueOrThrow({ where: { id } })).status).toBe('PAID');
    }
  });
});
