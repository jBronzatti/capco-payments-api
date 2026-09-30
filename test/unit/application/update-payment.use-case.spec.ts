import {
  ConcurrentUpdateError,
  PaymentNotFoundError,
  PermissionDeniedError,
} from '../../../src/application/errors';
import { UpdatePaymentUseCase } from '../../../src/application/use-cases/update-payment.use-case';
import { InvalidTransitionError, StatusManagedByProviderError } from '../../../src/domain/payment/errors';
import { Payment, PaymentChanges, PaymentSnapshot } from '../../../src/domain/payment/payment';
import { DomainValidationError } from '../../../src/domain/shared/domain-validation.error';
import { InMemoryPaymentRepository } from '../../fakes/in-memory-payment.repository';
import { RecordingAuditLog } from '../../fakes/recording-audit-log';

const ID = '0b7c8f0e-6a0e-4a53-9a57-0d7d9e0c1a11';
const SETTLER = { id: 'operator', canSettle: true };
const CLIENT = { id: 'client', canSettle: false };

function stored(overrides: Partial<PaymentSnapshot> = {}): Payment {
  const at = new Date('2026-09-29T12:00:00.000Z');
  return Payment.restore({
    id: ID,
    cpf: '12345678909',
    description: 'Pedido',
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
    ...overrides,
  });
}

/** Lets another writer commit between the use case's read and its conditional write. */
class InterleavingRepository extends InMemoryPaymentRepository {
  private readonly concurrentWrites: PaymentChanges[] = [];

  commitBeforeNextWrites(...changes: PaymentChanges[]): void {
    this.concurrentWrites.push(...changes);
  }

  override async update(id: string, expectedVersion: number, changes: PaymentChanges) {
    const concurrent = this.concurrentWrites.shift();
    if (concurrent) {
      const current = await this.findById(id);
      await super.update(id, current?.version ?? -1, concurrent);
    }
    return super.update(id, expectedVersion, changes);
  }
}

describe('UpdatePaymentUseCase', () => {
  let repository: InterleavingRepository;
  let useCase: UpdatePaymentUseCase;
  let audit: RecordingAuditLog;

  const seed = async (overrides: Partial<PaymentSnapshot> = {}) => repository.insert(stored(overrides));

  beforeEach(() => {
    repository = new InterleavingRepository();
    audit = new RecordingAuditLog();
    useCase = new UpdatePaymentUseCase(repository, audit);
  });

  it('changes the description of a pending payment for any authenticated client', async () => {
    await seed();

    const updated = await useCase.execute({ id: ID, description: ' Novo texto ', actor: CLIENT });

    expect(updated.toSnapshot()).toMatchObject({ description: 'Novo texto', version: 1 });
  });

  it('requires at least one field to change', async () => {
    await seed();

    await expect(useCase.execute({ id: ID, actor: SETTLER })).rejects.toThrow(DomainValidationError);
  });

  it('refuses a status change without the settle permission, before looking the payment up', async () => {
    await expect(useCase.execute({ id: ID, status: 'PAID', actor: CLIENT })).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('settles a pending PIX payment for a caller with the settle permission', async () => {
    await seed();

    const updated = await useCase.execute({ id: ID, status: 'PAID', actor: SETTLER });

    expect(updated.toSnapshot()).toMatchObject({ status: 'PAID', failureReason: null, version: 1 });
  });

  it('applies description and status together in a single write', async () => {
    await seed();

    const updated = await useCase.execute({ id: ID, description: 'Pago', status: 'FAIL', actor: SETTLER });

    expect(updated.toSnapshot()).toMatchObject({
      description: 'Pago',
      status: 'FAIL',
      failureReason: 'MANUAL',
      version: 1,
    });
  });

  it('treats a repeated request for the current status as a no-op without writing', async () => {
    await seed({ status: 'PAID', version: 3 });

    const result = await useCase.execute({ id: ID, status: 'PAID', actor: SETTLER });

    expect(result.version).toBe(3);
  });

  it('keeps a repeated combined PUT idempotent: the same description and status again change nothing', async () => {
    await seed({ description: 'Pago', status: 'PAID', version: 1 });

    const result = await useCase.execute({ id: ID, description: 'Pago', status: 'PAID', actor: SETTLER });

    expect(result.version).toBe(1);
    expect(audit.records).toEqual([]);
  });

  it.each([
    [
      'a card payment status',
      { paymentMethod: 'CREDIT_CARD' as const },
      { status: 'PAID' as const },
      StatusManagedByProviderError,
    ],
    [
      'a settled PIX payment status',
      { status: 'PAID' as const },
      { status: 'FAIL' as const },
      InvalidTransitionError,
    ],
    [
      'the description of a settled payment',
      { status: 'PAID' as const },
      { description: 'x' },
      InvalidTransitionError,
    ],
  ])('refuses to change %s', async (_label, state, change, error) => {
    await seed(state);

    await expect(useCase.execute({ id: ID, ...change, actor: SETTLER })).rejects.toThrow(error);
  });

  describe('audit trail', () => {
    it('records who moved a payment from one status to another', async () => {
      await seed();

      await useCase.execute({ id: ID, status: 'FAIL', actor: SETTLER });

      expect(audit.records).toEqual([{ paymentId: ID, from: 'PENDING', to: 'FAIL', actor: 'operator' }]);
    });

    it.each([
      ['a repeated status', { status: 'PAID' as const }, { status: 'PAID' as const }],
      ['a description-only edit', {}, { description: 'Novo' }],
    ])('records nothing for %s', async (_label, state, change) => {
      await seed(state);

      await useCase.execute({ id: ID, ...change, actor: SETTLER });

      expect(audit.records).toEqual([]);
    });
  });

  it('reports an unknown payment as not found', async () => {
    await expect(useCase.execute({ id: ID, description: 'x', actor: CLIENT })).rejects.toThrow(
      PaymentNotFoundError,
    );
  });

  describe('when another writer commits between read and write', () => {
    it('re-reads and re-applies a change that is still allowed', async () => {
      await seed();
      repository.commitBeforeNextWrites({ description: 'Concorrente' });

      const updated = await useCase.execute({ id: ID, status: 'PAID', actor: SETTLER });

      expect(updated.toSnapshot()).toMatchObject({ status: 'PAID', description: 'Concorrente', version: 2 });
      expect(audit.records).toEqual([{ paymentId: ID, from: 'PENDING', to: 'PAID', actor: 'operator' }]);
    });

    it('re-evaluates the rules and refuses a change the concurrent write made illegal', async () => {
      await seed();
      repository.commitBeforeNextWrites({ status: 'PAID', failureReason: null });

      await expect(useCase.execute({ id: ID, description: 'Tarde', actor: CLIENT })).rejects.toThrow(
        InvalidTransitionError,
      );
      expect(repository.snapshot(ID)).toMatchObject({ status: 'PAID', description: 'Pedido' });
    });

    it('gives up with a conflict after a second concurrent write', async () => {
      await seed();
      repository.commitBeforeNextWrites({ description: 'Primeiro' }, { description: 'Segundo' });

      await expect(useCase.execute({ id: ID, description: 'Meu', actor: CLIENT })).rejects.toThrow(
        ConcurrentUpdateError,
      );
    });
  });
});
