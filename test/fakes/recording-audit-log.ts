import { PaymentAuditLog, StatusChangeRecord } from '../../src/application/ports/payment-audit-log';

export class RecordingAuditLog implements PaymentAuditLog {
  readonly records: StatusChangeRecord[] = [];

  statusChanged(record: StatusChangeRecord): void {
    this.records.push(record);
  }
}
