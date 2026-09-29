import { CreatePaymentUseCase } from '../../../src/application/use-cases/create-payment.use-case';
import { DomainValidationError } from '../../../src/domain/shared/domain-validation.error';
import { InMemoryPaymentRepository } from '../../fakes/in-memory-payment.repository';
import { RecordingAuditLog } from '../../fakes/recording-audit-log';

describe('CreatePaymentUseCase — PIX', () => {
  let repository: InMemoryPaymentRepository;
  let useCase: CreatePaymentUseCase;

  beforeEach(() => {
    repository = new InMemoryPaymentRepository();
    useCase = new CreatePaymentUseCase(
      repository,
      { maxAmountCents: 100_000_000 },
      null,
      new RecordingAuditLog(),
    );
  });

  it('persists a PIX payment as PENDING and returns it', async () => {
    const payment = await useCase.execute({
      cpf: '123.456.789-09',
      description: '  Pedido #123 ',
      amount: 150.75,
      paymentMethod: 'PIX',
    });

    expect(repository.snapshot(payment.id)).toMatchObject({
      cpf: '12345678909',
      description: 'Pedido #123',
      amountCents: 15075,
      paymentMethod: 'PIX',
      status: 'PENDING',
      version: 0,
    });
  });

  it('assigns a server-side UUID to every payment', async () => {
    const payment = await useCase.execute({
      cpf: '12345678909',
      description: 'x',
      amount: 1,
      paymentMethod: 'PIX',
    });
    expect(payment.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('rejects an amount above the configured cap without persisting anything', async () => {
    const attempt = useCase.execute({
      cpf: '12345678909',
      description: 'x',
      amount: 1_000_000.01,
      paymentMethod: 'PIX',
    });

    await expect(attempt).rejects.toThrow(DomainValidationError);
    expect(repository.count()).toBe(0);
  });

  it('rejects an invalid CPF without persisting anything', async () => {
    const attempt = useCase.execute({
      cpf: '12345678900',
      description: 'x',
      amount: 10,
      paymentMethod: 'PIX',
    });

    await expect(attempt).rejects.toThrow(DomainValidationError);
    expect(repository.count()).toBe(0);
  });
});
