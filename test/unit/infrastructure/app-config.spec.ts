import { createHash } from 'node:crypto';
import { ConfigError, DEMO_API_KEY, loadConfig } from '../../../src/infrastructure/config/app-config';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const CLIENT_HASH = sha256('client-key-with-plenty-of-entropy-0001');
const OPERATOR_HASH = sha256('operator-key-with-plenty-of-entropy-0002');

const base = {
  DATABASE_URL: 'postgresql://app:app@localhost:5432/payments',
  API_KEYS: `client:${CLIENT_HASH}`,
};

describe('loadConfig', () => {
  it('applies safe defaults to a minimal environment', () => {
    expect(loadConfig(base)).toMatchObject({
      port: 3000,
      maxAmountCents: 100_000_000,
      demoMode: false,
      apiKeys: [{ id: 'client', canSettle: false }],
    });
  });

  it('grants the settle permission only to keys that declare it', () => {
    const config = loadConfig({
      ...base,
      API_KEYS: `client:${CLIENT_HASH},operator:${OPERATOR_HASH}:settle`,
    });

    expect(config.apiKeys.map(({ id, canSettle }) => ({ id, canSettle }))).toEqual([
      { id: 'client', canSettle: false },
      { id: 'operator', canSettle: true },
    ]);
  });

  it('lists every missing required variable by name', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL.*API_KEYS/);
  });

  it.each([
    ['a hash that is not 64 hex characters', 'client:abc123'],
    ['an unknown permission', `client:${CLIENT_HASH}:admin`],
    ['a duplicated key id', `client:${CLIENT_HASH},client:${OPERATOR_HASH}`],
    ['an invalid key id', `Client Key:${CLIENT_HASH}`],
  ])('rejects API_KEYS with %s', (_label, apiKeys) => {
    expect(() => loadConfig({ ...base, API_KEYS: apiKeys })).toThrow(ConfigError);
  });

  it('rejects the same key registered under two ids', () => {
    expect(() => loadConfig({ ...base, API_KEYS: `client:${CLIENT_HASH},other:${CLIENT_HASH}` })).toThrow(
      /duplicated key/,
    );
  });

  it('reports malformed entries without a spurious duplicate-id complaint', () => {
    expect(() => loadConfig({ ...base, API_KEYS: 'a:bad,b:bad' })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('duplicated') }),
    );
  });

  it('never echoes a configured value in its error message', () => {
    const secretLookingValue = 'client:not-a-hash-but-maybe-a-leaked-plaintext-key';
    expect(() => loadConfig({ ...base, API_KEYS: secretLookingValue })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('leaked-plaintext-key') }),
    );
  });

  it('rejects an amount cap above the integer column ceiling', () => {
    expect(() => loadConfig({ ...base, MAX_AMOUNT_CENTS: '2147483648' })).toThrow(ConfigError);
  });

  it('accepts the published demo key only in explicit demo mode', () => {
    const withDemoKey = { ...base, API_KEYS: `demo:${sha256(DEMO_API_KEY)}` };

    expect(() => loadConfig(withDemoKey)).toThrow(/demo/i);
    expect(loadConfig({ ...withDemoKey, DEMO_MODE: 'true' }).demoMode).toBe(true);
  });

  describe('card payments (Mercado Pago)', () => {
    const TOKEN = 'TEST-fake-access-token';
    const card = {
      MP_ACCESS_TOKEN: TOKEN,
      MP_WEBHOOK_SECRET: 'webhook-secret-value',
      MP_COLLECTOR_ID: '111222333',
    };

    it('leaves card payments unconfigured when no Mercado Pago variable is set', () => {
      expect(loadConfig(base).card).toBeNull();
    });

    it('configures card payments with bounded provider defaults when all variables are set', () => {
      expect(loadConfig({ ...base, ...card }).card).toEqual({
        accessToken: TOKEN,
        webhookSecret: 'webhook-secret-value',
        collectorId: '111222333',
        checkoutTtlMinutes: 30,
        requestTimeoutMs: 8_000,
      });
    });

    it('refuses a partial Mercado Pago configuration, explaining that the variables go together', () => {
      const attempt = () => loadConfig({ ...base, MP_ACCESS_TOKEN: TOKEN });

      expect(attempt).toThrow(/together, or none \(missing: MP_WEBHOOK_SECRET, MP_COLLECTOR_ID\)/);
      expect(attempt).toThrow(expect.objectContaining({ message: expect.not.stringContaining(TOKEN) }));
    });

    it('requires a numeric collector id', () => {
      expect(() => loadConfig({ ...base, ...card, MP_COLLECTOR_ID: 'seller-account' })).toThrow(
        /MP_COLLECTOR_ID/,
      );
    });

    it('fails when a deployment requires card payments but they are not configured', () => {
      expect(() => loadConfig({ ...base, REQUIRE_CARD_PAYMENTS: 'true' })).toThrow(/REQUIRE_CARD_PAYMENTS/);
    });

    it('refuses the published demo key whenever card payments are configured, even in demo mode', () => {
      const demoWithCard = { ...base, ...card, API_KEYS: `demo:${sha256(DEMO_API_KEY)}`, DEMO_MODE: 'true' };

      expect(() => loadConfig(demoWithCard)).toThrow(/demo/i);
    });
  });
});
