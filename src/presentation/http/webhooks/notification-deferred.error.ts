/** A verified notification that could not be settled now; a non-2xx answer makes Mercado Pago redeliver it. */
export class NotificationDeferredError extends Error {
  override readonly name = 'NotificationDeferredError';
}
