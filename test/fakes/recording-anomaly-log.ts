import { ProviderAnomaly, ProviderAnomalyLog } from '../../src/application/ports/provider-anomaly-log';

export class RecordingAnomalyLog implements ProviderAnomalyLog {
  readonly anomalies: ProviderAnomaly[] = [];

  async record(anomaly: ProviderAnomaly): Promise<void> {
    this.anomalies.push(anomaly);
  }
}
