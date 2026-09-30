import { ProviderAnomaly, ProviderAnomalyLog } from '../../application/ports/provider-anomaly-log';
import { PrismaClient } from '../../generated/prisma/client';

export class PrismaProviderAnomalyLog implements ProviderAnomalyLog {
  constructor(private readonly prisma: PrismaClient) {}

  /** A redelivered observation is a no-op, not an error; a new provider status is a new row. */
  async record(anomaly: ProviderAnomaly): Promise<void> {
    await this.prisma.providerAnomaly.createMany({ data: [anomaly], skipDuplicates: true });
  }
}
