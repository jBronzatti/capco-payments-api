import { createHmac, randomUUID } from 'node:crypto';

export interface SignedDelivery {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * A notification shaped like Mercado Pago's documented webhook, signed the documented way with the given
 * secret: HMAC-SHA256 over `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`.
 */
export function signedDelivery(
  secret: string,
  dataId: string,
  options: { type?: string; requestId?: string; ts?: string } = {},
): SignedDelivery {
  const { type = 'payment', requestId = randomUUID(), ts = String(Math.floor(Date.now() / 1000)) } = options;
  const hash = createHmac('sha256', secret)
    .update(`id:${dataId};request-id:${requestId};ts:${ts};`)
    .digest('hex');
  return {
    path: `/api/webhooks/mercado-pago?data.id=${dataId}&type=${type}`,
    headers: { 'x-signature': `ts=${ts},v1=${hash}`, 'x-request-id': requestId },
    body: { action: 'payment.updated', api_version: 'v1', type, live_mode: false, data: { id: dataId } },
  };
}
