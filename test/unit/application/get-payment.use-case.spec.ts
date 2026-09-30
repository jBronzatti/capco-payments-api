import { PaymentNotFoundError } from '../../../src/application/errors';
import { CreatePaymentUseCase } from '../../../src/application/use-cases/create-payment.use-case';
import { GetPaymentUseCase } from '../../../src/application/use-cases/get-payment.use-case';
import { InMemoryPaymentRepository } from '../../fakes/in-memory-payment.repository';
import { RecordingAuditLog } from '../../fakes/recording-audit-log';

describe('GetPaymentUseCase', () => {
  it('returns a stored payment', async () => {
    const repository = new InMemoryPaymentRepository();
    const created = await new CreatePaymentUseCase(
      repository,
      { maxAmountCents: 100_000_000 },
      null,
      new RecordingAuditLog(),
    ).execute({
      cpf: '12345678909',
      description: 'Pedido',
      amount: 10,
      paymentMethod: 'PIX',
    });

    const found = await new GetPaymentUseCase(repository).execute(created.id);

    expect(found.toSnapshot()).toEqual(created.toSnapshot());
  });

  it('reports an unknown id as not found', async () => {
    const useCase = new GetPaymentUseCase(new InMemoryPaymentRepository());

    await expect(useCase.execute('7d4f6a3e-2b1c-4d5e-8f90-a1b2c3d4e5f6')).rejects.toThrow(
      PaymentNotFoundError,
    );
  });
});
