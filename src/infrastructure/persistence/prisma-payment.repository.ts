import { PaymentPage, PaymentQuery, PaymentRepository } from '../../application/ports/payment-repository';
import { Payment, PaymentChanges } from '../../domain/payment/payment';
import { Prisma, PrismaClient } from '../../generated/prisma/client';
import type { Payment as PaymentRow } from '../../generated/prisma/client';

const RECORD_NOT_FOUND = 'P2025';

export class PrismaPaymentRepository implements PaymentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(payment: Payment): Promise<void> {
    await this.prisma.payment.create({ data: payment.toSnapshot() });
  }

  async findById(id: string): Promise<Payment | null> {
    const row = await this.prisma.payment.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async findMany(query: PaymentQuery): Promise<PaymentPage> {
    const where = toWhere(query);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.payment.count({ where }),
    ]);
    return { items: rows.map(toDomain), total };
  }

  /** One conditional statement: the returned row is exactly the one this call wrote. */
  async update(id: string, expectedVersion: number, changes: PaymentChanges): Promise<Payment | null> {
    try {
      const row = await this.prisma.payment.update({
        where: { id, version: expectedVersion },
        data: { ...changes, version: { increment: 1 }, updatedAt: new Date() },
      });
      return toDomain(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === RECORD_NOT_FOUND) {
        return null;
      }
      throw error;
    }
  }
}

function toWhere(query: PaymentQuery): Prisma.PaymentWhereInput {
  return {
    ...(query.cpf ? { cpf: query.cpf.value } : {}),
    ...(query.paymentMethod ? { paymentMethod: query.paymentMethod } : {}),
    ...(query.status ? { status: query.status } : {}),
  };
}

function toDomain(row: PaymentRow): Payment {
  return Payment.restore(row);
}
