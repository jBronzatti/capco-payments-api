import { PrismaClient } from '../../generated/prisma/client';

export class DatabaseReadiness {
  constructor(private readonly prisma: PrismaClient) {}

  async check(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }
}
