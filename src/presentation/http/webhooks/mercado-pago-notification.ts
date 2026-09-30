import { UnauthorizedError } from '../auth/auth';
import { RequestValidationError } from '../validation';

/** The parts of an HTTP request a Mercado Pago notification is read from; an Express request fits it. */
export interface NotificationRequest {
  query: Record<string, unknown>;
  body: unknown;
  headersDistinct: Record<string, string[] | undefined>;
}

/** One unambiguous value per field: the id that is verified is the id that is re-fetched. */
export interface SignedNotification {
  dataId: string;
  type: string;
  /** The raw x-signature header; the timestamp inside it is signed exactly as received. */
  signature: string;
  requestId: string;
}

const PROVIDER_PAYMENT_ID = /^\d{1,20}$/;

/**
 * Canonicalises a notification before its signature is checked. Anything ambiguous (a repeated id, header or
 * signature part; a body that disagrees with the query) is refused, because a verifier and a handler that
 * read different values could validate one payment and act on another.
 */
export function canonicalNotification(request: NotificationRequest): SignedNotification {
  const body = asRecord(request.body);
  const dataId = request.query['data.id'];
  if (!isProviderPaymentId(dataId)) malformed('data.id', 'must be one numeric id');
  if (!bodyIdAgrees(asRecord(body.data).id, dataId)) malformed('data.id', 'must match the id in the query');
  return {
    dataId,
    type: canonicalType(request.query.type, body.type),
    ...signatureHeaders(request.headersDistinct),
  };
}

function isProviderPaymentId(value: unknown): value is string {
  return typeof value === 'string' && PROVIDER_PAYMENT_ID.test(value);
}

function bodyIdAgrees(bodyId: unknown, dataId: string): boolean {
  if (bodyId === undefined) return true;
  return (typeof bodyId === 'string' || typeof bodyId === 'number') && String(bodyId) === dataId;
}

function canonicalType(queryType: unknown, bodyType: unknown): string {
  const type = queryType ?? bodyType;
  if (typeof type !== 'string') malformed('type', 'must be one value');
  if (bodyType !== undefined && bodyType !== type) malformed('type', 'must match between query and body');
  return type;
}

function signatureHeaders(
  headers: NotificationRequest['headersDistinct'],
): Pick<SignedNotification, 'signature' | 'requestId'> {
  const signature = singleHeader(headers, 'x-signature');
  const requestId = singleHeader(headers, 'x-request-id');
  if (!signature || !requestId) throw new UnauthorizedError('A signed notification is required');
  const parts = signature.split(',').map((part) => part.split('=')[0]?.trim().toLowerCase());
  const repeated = ['ts', 'v1'].some((key) => parts.filter((part) => part === key).length > 1);
  if (repeated) malformed('x-signature', 'must carry one timestamp and one v1 hash');
  return { signature, requestId };
}

function singleHeader(headers: NotificationRequest['headersDistinct'], name: string): string | undefined {
  const values = headers[name] ?? [];
  if (values.length > 1) malformed(name, 'must be sent once');
  return values[0];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function malformed(field: string, message: string): never {
  throw new RequestValidationError([{ field, message: `${field} ${message}` }]);
}
