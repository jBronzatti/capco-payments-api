import { createHmac } from 'node:crypto';
import { MercadoPagoNotificationVerifier } from '../../../src/infrastructure/mercado-pago/mercado-pago-notification.verifier';

const SECRET = 'test-webhook-secret';
const DATA_ID = '123456';
const REQUEST_ID = 'bb56a2f1-6aae-46ac-982e-9dcd3581d08e';
const TS = '1704908010';

/** Mercado Pago's documented manifest, signed independently of the SDK the verifier delegates to. */
function sign(parts: { dataId?: string; requestId?: string; ts?: string; secret?: string } = {}): string {
  const { dataId = DATA_ID, requestId = REQUEST_ID, ts = TS, secret = SECRET } = parts;
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  return `ts=${ts},v1=${createHmac('sha256', secret).update(manifest).digest('hex')}`;
}

const notification = (signature: string) => ({
  dataId: DATA_ID,
  type: 'payment',
  signature,
  requestId: REQUEST_ID,
});

describe('MercadoPagoNotificationVerifier', () => {
  const verifier = new MercadoPagoNotificationVerifier(SECRET);

  it('accepts a notification signed with our secret over its id, request id and timestamp', () => {
    expect(verifier.verify(notification(sign()))).toBe(true);
  });

  it.each([
    ['another secret', sign({ secret: 'another-secret' })],
    ['another payment id', sign({ dataId: '999' })],
    ['another request id', sign({ requestId: 'another-request' })],
    ['a timestamp that is not the signed one', sign().replace(`ts=${TS}`, 'ts=1704908011')],
    ['a truncated hash', sign().slice(0, -2)],
    ['no hash', `ts=${TS}`],
    ['an unparseable header', 'not-a-signature'],
    ['a non-numeric timestamp', sign({ ts: 'abc' })],
  ])('rejects a signature made with %s', (_label, signature) => {
    expect(verifier.verify(notification(signature))).toBe(false);
  });

  // Replays end as no-ops after a fresh re-fetch; a freshness window waits for observed redelivery behaviour.
  it('does not reject an old timestamp', () => {
    expect(verifier.verify(notification(sign({ ts: '1000000000' })))).toBe(true);
  });
});
