import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { Money } from '../../domain/shared/money';

/** Published on purpose for the one-command local demo; accepted only with DEMO_MODE=true. */
export const DEMO_API_KEY = 'demo-key-local-pix-testing-only';
const DEMO_API_KEY_SHA256 = createHash('sha256').update(DEMO_API_KEY).digest('hex');

const KEY_ID = /^[a-z0-9_-]{1,32}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface ApiKeyRecord {
  id: string;
  sha256: Buffer;
  canSettle: boolean;
}

export interface CardPaymentsConfig {
  accessToken: string;
  webhookSecret: string;
  /** The Mercado Pago user id that must own every preference and payment we act on. */
  collectorId: string;
  checkoutTtlMinutes: number;
  /** Per call, and SDK retries are disabled, so this is also the total provider time per request. */
  requestTimeoutMs: number;
}

export interface AppConfig {
  /** Listen address. Loopback by default; containers set 0.0.0.0 so the published port reaches the API. */
  host: string;
  port: number;
  databaseUrl: string;
  apiKeys: ApiKeyRecord[];
  maxAmountCents: number;
  demoMode: boolean;
  logLevel: LogLevel;
  /** Null when card payments are not configured; card requests then fail with 503 before any write. */
  card: CardPaymentsConfig | null;
}

const CARD_VARIABLES = ['MP_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET', 'MP_COLLECTOR_ID'] as const;

/** Lists what is wrong by variable name only; configured values are never echoed. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';

  constructor(readonly problems: string[]) {
    super(`Invalid configuration: ${problems.join('; ')}`);
  }
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env): AppConfig {
  const read = new EnvReader(env);
  const config: AppConfig = {
    host: read.listenAddress('HOST', '127.0.0.1'),
    port: read.integer('PORT', 3000, 1, 65_535),
    databaseUrl: read.required('DATABASE_URL'),
    apiKeys: parseApiKeys(read.required('API_KEYS'), read.problems),
    maxAmountCents: read.integer('MAX_AMOUNT_CENTS', 100_000_000, 1, Money.MAX_CENTS),
    demoMode: read.boolean('DEMO_MODE', false),
    logLevel: read.oneOf('LOG_LEVEL', LOG_LEVELS, 'info'),
    card: readCardConfig(read),
  };
  if (usesDemoKey(config) && (!config.demoMode || config.card)) {
    read.problems.push(
      'API_KEYS contains the published demo key, which is only allowed with DEMO_MODE=true and without card payments',
    );
  }
  if (read.boolean('REQUIRE_CARD_PAYMENTS', false) && !config.card) {
    read.problems.push('REQUIRE_CARD_PAYMENTS=true but card payments are not configured');
  }
  if (read.problems.length > 0) throw new ConfigError(read.problems);
  return config;
}

/** All three variables or none: a partial set is a misconfiguration, never a silently disabled feature. */
function readCardConfig(read: EnvReader): CardPaymentsConfig | null {
  if (!CARD_VARIABLES.some((name) => read.isSet(name))) return null;
  const missing = CARD_VARIABLES.filter((name) => !read.isSet(name));
  if (missing.length > 0) {
    read.problems.push(`Set ${CARD_VARIABLES.join(', ')} together, or none (missing: ${missing.join(', ')})`);
  }
  const accessToken = read.text('MP_ACCESS_TOKEN');
  const webhookSecret = read.text('MP_WEBHOOK_SECRET');
  const collectorId = read.text('MP_COLLECTOR_ID');
  if (collectorId !== '' && !/^\d{1,20}$/.test(collectorId)) {
    read.problems.push('MP_COLLECTOR_ID must be the numeric Mercado Pago user id');
  }
  return {
    accessToken,
    webhookSecret,
    collectorId,
    checkoutTtlMinutes: read.integer('CHECKOUT_TTL_MINUTES', 30, 5, 24 * 60),
    requestTimeoutMs: read.integer('MP_REQUEST_TIMEOUT_MS', 8_000, 1_000, 15_000),
  };
}

function usesDemoKey(config: AppConfig): boolean {
  return config.apiKeys.some((key) => key.sha256.toString('hex') === DEMO_API_KEY_SHA256);
}

/** Format: `id:sha256hex[:settle]`, comma-separated. */
function parseApiKeys(raw: string, problems: string[]): ApiKeyRecord[] {
  if (raw === '') return [];
  const records = raw
    .split(',')
    .map((entry, index) => parseApiKey(entry.trim(), index + 1, problems))
    .filter((record): record is ApiKeyRecord => record !== null);
  if (hasDuplicates(records.map((record) => record.id))) {
    problems.push('API_KEYS contains a duplicated key id');
  }
  if (hasDuplicates(records.map((record) => record.sha256.toString('hex')))) {
    problems.push('API_KEYS contains a duplicated key');
  }
  return records;
}

function hasDuplicates(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

function parseApiKey(entry: string, position: number, problems: string[]): ApiKeyRecord | null {
  const [id = '', hash = '', permission, ...rest] = entry.split(':');
  const valid =
    KEY_ID.test(id) && SHA256_HEX.test(hash) && (permission === undefined || permission === 'settle');
  if (!valid || rest.length > 0) {
    problems.push(`API_KEYS entry ${position} must look like id:sha256hex or id:sha256hex:settle`);
    return null;
  }
  return { id, sha256: Buffer.from(hash, 'hex'), canSettle: permission === 'settle' };
}

class EnvReader {
  readonly problems: string[] = [];

  constructor(private readonly env: Env) {}

  required(name: string): string {
    const value = this.env[name]?.trim() ?? '';
    if (value === '') this.problems.push(`${name} is required`);
    return value;
  }

  isSet(name: string): boolean {
    return this.text(name) !== '';
  }

  text(name: string): string {
    return this.env[name]?.trim() ?? '';
  }

  integer(name: string, fallback: number, min: number, max: number): number {
    const raw = this.optional(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (Number.isInteger(value) && value >= min && value <= max) return value;
    this.problems.push(`${name} must be an integer between ${min} and ${max}`);
    return fallback;
  }

  /** An IP literal only: a typo or a name (localhost may resolve to ::1 alone) must not pick the interface. */
  listenAddress(name: string, fallback: string): string {
    const raw = this.optional(name);
    if (raw === undefined) return fallback;
    if (isIP(raw) !== 0) return raw;
    this.problems.push(`${name} must be an IP address`);
    return fallback;
  }

  boolean(name: string, fallback: boolean): boolean {
    const raw = this.optional(name);
    if (raw === undefined) return fallback;
    if (raw === 'true' || raw === 'false') return raw === 'true';
    this.problems.push(`${name} must be true or false`);
    return fallback;
  }

  oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
    const raw = this.optional(name);
    if (raw === undefined) return fallback;
    const match = allowed.find((value) => value === raw);
    if (match) return match;
    this.problems.push(`${name} must be one of ${allowed.join(', ')}`);
    return fallback;
  }

  private optional(name: string): string | undefined {
    const raw = this.env[name]?.trim();
    return raw === undefined || raw === '' ? undefined : raw;
  }
}
