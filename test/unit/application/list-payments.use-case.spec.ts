import { ListPaymentsUseCase } from '../../../src/application/use-cases/list-payments.use-case';
import { Payment, PaymentSnapshot } from '../../../src/domain/payment/payment';
import { DomainValidationError } from '../../../src/domain/shared/domain-validation.error';
import { InMemoryPaymentRepository } from '../../fakes/in-memory-payment.repository';

const at = (minute: number) => new Date(Date.UTC(2026, 8, 29, 12, minute));

function stored(overrides: Partial<PaymentSnapshot>): Payment {
  return Payment.restore({
    id: '00000000-0000-4000-8000-000000000000',
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
    createdAt: at(0),
    updatedAt: at(0),
    ...overrides,
  });
}

describe('ListPaymentsUseCase', () => {
  let repository: InMemoryPaymentRepository;
  let useCase: ListPaymentsUseCase;

  beforeEach(async () => {
    repository = new InMemoryPaymentRepository();
    useCase = new ListPaymentsUseCase(repository);
    await repository.insert(stored({ id: '00000000-0000-4000-8000-000000000001', createdAt: at(1) }));
    await repository.insert(stored({ id: '00000000-0000-4000-8000-000000000002', createdAt: at(2) }));
    await repository.insert(
      stored({ id: '00000000-0000-4000-8000-000000000003', cpf: '52998224725', createdAt: at(3) }),
    );
  });

  it.each(['123.456.789-09', '12345678909'])('filters by CPF given as %p', async (cpf) => {
    const page = await useCase.execute({ cpf, page: 1, limit: 10 });

    expect(page.items.map((payment) => payment.id)).toEqual([
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(page.total).toBe(2);
  });

  it('echoes the page and limit it applied', async () => {
    const page = await useCase.execute({ page: 2, limit: 2 });

    expect(page).toMatchObject({ page: 2, limit: 2, total: 3 });
    expect(page.items.map((payment) => payment.id)).toEqual(['00000000-0000-4000-8000-000000000001']);
  });

  it('rejects an invalid CPF filter instead of silently matching nothing', async () => {
    await expect(useCase.execute({ cpf: '11111111111', page: 1, limit: 10 })).rejects.toThrow(
      DomainValidationError,
    );
  });
});
