import { UnauthorizedError } from '../../../src/presentation/http/auth/auth';
import { RequestValidationError } from '../../../src/presentation/http/validation';
import {
  canonicalNotification,
  NotificationRequest,
} from '../../../src/presentation/http/webhooks/mercado-pago-notification';

const SIGNATURE = 'ts=1704908010,v1=618c85345248dd820d5fd456117c2ab2ef8eda45a0282ff693eac24131a5e839';
const REQUEST_ID = 'bb56a2f1-6aae-46ac-982e-9dcd3581d08e';

function notification(overrides: Partial<NotificationRequest> = {}): NotificationRequest {
  return {
    query: { 'data.id': '123456', type: 'payment' },
    body: { action: 'payment.updated', type: 'payment', data: { id: '123456' } },
    headersDistinct: { 'x-signature': [SIGNATURE], 'x-request-id': [REQUEST_ID] },
    ...overrides,
  };
}

const withQuery = (query: Record<string, unknown>) => notification({ query });
const withBody = (body: unknown) => notification({ body });
const withHeaders = (headers: Record<string, string[] | undefined>) =>
  notification({ headersDistinct: { 'x-signature': [SIGNATURE], 'x-request-id': [REQUEST_ID], ...headers } });

function rejectedField(request: NotificationRequest): string | undefined {
  try {
    canonicalNotification(request);
  } catch (error) {
    if (error instanceof RequestValidationError) return error.errors[0]?.field;
    throw error;
  }
  throw new Error('the notification was accepted');
}

describe('canonicalNotification', () => {
  it('extracts the one id that is both verified and re-fetched, with the raw signature inputs', () => {
    expect(canonicalNotification(notification())).toEqual({
      dataId: '123456',
      type: 'payment',
      signature: SIGNATURE,
      requestId: REQUEST_ID,
    });
  });

  it('accepts a body that repeats the id as a number, or carries neither id nor type', () => {
    expect(canonicalNotification(withBody({ data: { id: 123456 } })).dataId).toBe('123456');
    expect(canonicalNotification(withBody(undefined)).dataId).toBe('123456');
  });

  it('takes the type from the body when the query has none', () => {
    expect(canonicalNotification(withQuery({ 'data.id': '123456' })).type).toBe('payment');
  });

  it('accepts the longest id it allows', () => {
    const id = '9'.repeat(20);
    expect(
      canonicalNotification(notification({ query: { 'data.id': id, type: 'payment' }, body: {} })).dataId,
    ).toBe(id);
  });

  describe('rejects ambiguity before any signature check, so one id cannot be verified and another acted on', () => {
    it.each([
      ['a missing id', { type: 'payment' }],
      ['a repeated id', { 'data.id': ['123456', '999'], type: 'payment' }],
      ['an id with letters', { 'data.id': '12a456', type: 'payment' }],
      ['a signed id', { 'data.id': '-123456', type: 'payment' }],
      ['an id with spaces', { 'data.id': ' 123456', type: 'payment' }],
      ['an id longer than 20 digits', { 'data.id': '9'.repeat(21), type: 'payment' }],
      ['an empty id', { 'data.id': '', type: 'payment' }],
    ])('%s', (_label, query) => {
      expect(rejectedField(withQuery(query))).toBe('data.id');
    });

    it.each([
      ['a body id that differs from the query id', { data: { id: '999' } }],
      ['a body id hidden in an array', { data: { id: ['123456'] } }],
      ['a body id that is an object', { data: { id: { value: '123456' } } }],
    ])('%s', (_label, body) => {
      expect(rejectedField(withBody(body))).toBe('data.id');
    });

    it.each([
      ['a repeated type', withQuery({ 'data.id': '123456', type: ['payment', 'payment'] })],
      [
        'a query and body that disagree on the type',
        withBody({ type: 'merchant_order', data: { id: '123456' } }),
      ],
      ['no type anywhere', notification({ query: { 'data.id': '123456' }, body: {} })],
      [
        'a body type that is not text',
        notification({ query: { 'data.id': '123456' }, body: { type: ['payment'] } }),
      ],
    ])('%s', (_label, request) => {
      expect(rejectedField(request)).toBe('type');
    });

    it.each([
      ['a repeated x-signature header', { 'x-signature': [SIGNATURE, SIGNATURE] }],
      ['two timestamps in one signature', { 'x-signature': [`ts=1,${SIGNATURE}`] }],
      ['two v1 hashes in one signature', { 'x-signature': [`${SIGNATURE},v1=abc`] }],
      ['a repeated x-request-id header', { 'x-request-id': [REQUEST_ID, 'other'] }],
    ])('%s', (_label, headers) => {
      expect(rejectedField(withHeaders(headers))).toMatch(/^x-/);
    });
  });

  it.each([
    ['no signature', { 'x-signature': undefined }],
    ['an empty signature', { 'x-signature': [''] }],
    ['no request id', { 'x-request-id': undefined }],
  ])('treats %s as unauthenticated: every part of the signed manifest is required', (_label, headers) => {
    expect(() => canonicalNotification(withHeaders(headers))).toThrow(UnauthorizedError);
  });
});
