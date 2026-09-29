import { InvalidWebhookSignatureError, WebhookSignatureValidator } from 'mercadopago';

interface NotificationSignatureInputs {
  dataId: string;
  signature: string;
  requestId: string;
}

/**
 * Mercado Pago's HMAC-SHA256 over `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, checked by the SDK in
 * constant time. The SDK resolves ambiguity silently (the first element of an array, the last `ts` or `v1`
 * inside the header), so callers pass canonical, unrepeated values only.
 * No timestamp tolerance: replays end as no-ops after the re-fetch, and a window could refuse redeliveries.
 */
export class MercadoPagoNotificationVerifier {
  constructor(private readonly secret: string) {}

  verify(notification: NotificationSignatureInputs): boolean {
    try {
      WebhookSignatureValidator.validate({
        xSignature: notification.signature,
        xRequestId: notification.requestId,
        dataId: notification.dataId,
        secret: this.secret,
      });
      return true;
    } catch (error) {
      if (error instanceof InvalidWebhookSignatureError) return false;
      throw error;
    }
  }
}
