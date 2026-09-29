import { serializeError, serializeRequest } from '../../../src/infrastructure/logging/log-serializers';

const CPF = '52998224725';

describe('serializeError', () => {
  const databaseError = () =>
    Object.assign(new Error(`Failing row contains (7d4f, ${CPF}, Pedido secreto, 100, PIX, FAIL)`), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2004',
      meta: {
        modelName: 'Payment',
        driverAdapterError: { cause: { detail: `Failing row contains (${CPF})` } },
      },
    });

  it('keeps the error type, code and model, and drops messages and metadata that may carry personal data', () => {
    const serialized = serializeError(databaseError());

    expect(serialized).toMatchObject({
      type: 'PrismaClientKnownRequestError',
      code: 'P2004',
      model: 'Payment',
    });
    expect(JSON.stringify(serialized)).not.toContain(CPF);
    expect(JSON.stringify(serialized)).not.toContain('Pedido secreto');
  });

  it('keeps stack frames but not the message line at the top of the stack', () => {
    const serialized = serializeError(databaseError());

    expect(serialized.stack).toMatch(/^\s+at /);
    expect(serialized.stack).not.toContain(CPF);
  });

  it('sanitises the cause chain the same way', () => {
    const error = new Error('wrapper', {
      cause: Object.assign(new Error(`detail ${CPF}`), { code: '23514' }),
    });

    const serialized = serializeError(error);

    expect(serialized.cause).toMatchObject({ type: 'Error', code: '23514' });
    expect(JSON.stringify(serialized)).not.toContain(CPF);
  });

  it('follows at most five causes, so a self-referencing error cannot overflow the stack', () => {
    const error = new Error('loop');
    error.cause = error;

    let depth = 0;
    for (let node = serializeError(error).cause; node; node = node.cause) depth += 1;

    expect(depth).toBe(5);
  });

  it('keeps boolean diagnostics that tell an operator a payment may be stuck', () => {
    const error = Object.assign(new Error('checkout failed'), { stateRecorded: false, timedOut: true });

    expect(serializeError(error)).toMatchObject({ stateRecorded: false, timedOut: true });
  });

  it('describes a thrown non-Error value without echoing it', () => {
    expect(serializeError(CPF)).toEqual({ type: 'string' });
  });
});

describe('serializeRequest', () => {
  it('logs the path and the query keys, never query values', () => {
    expect(serializeRequest({ id: 'r1', method: 'GET', url: `/api/payment?cpf=${CPF}&page=2` })).toEqual({
      id: 'r1',
      method: 'GET',
      path: '/api/payment',
      queryKeys: ['cpf', 'page'],
    });
  });

  it('decodes percent-encoded keys instead of pattern-matching the raw URL', () => {
    const serialized = serializeRequest({ id: 'r1', method: 'GET', url: `/api/payment?%63pf=${CPF}` });

    expect(serialized.queryKeys).toEqual(['cpf']);
    expect(JSON.stringify(serialized)).not.toContain(CPF);
  });

  it.each([
    ['an unmasked CPF in the path', `/api/payment/${CPF}`],
    ['a masked CPF in the path', '/api/payment/529.982.247-25'],
    ['a CPF used as a query key', `/api/payment?${CPF}=1`],
    [
      'a percent-encoded CPF in a segment that fails to decode',
      '/api/payment/%35%32%39%39%38%32%32%34%37%32%35%E0',
    ],
  ])('redacts %s', (_label, url) => {
    const serialized = JSON.stringify(serializeRequest({ id: 'r1', method: 'GET', url }));

    expect(serialized).not.toMatch(/529\.?982\.?247-?25/);
    expect(serialized).toContain('[REDACTED]');
  });

  it('keeps UUIDs intact', () => {
    const url = '/api/payment/00000000-0000-4000-8000-000000000001';
    expect(serializeRequest({ id: 'r1', method: 'GET', url }).path).toBe(url);
  });

  it('survives malformed percent-encoding', () => {
    expect(() => serializeRequest({ id: 'r1', method: 'GET', url: '/api/payment?%E0%A4%A=1' })).not.toThrow();
  });
});
