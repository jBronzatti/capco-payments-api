import { createHash, randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppOverrides } from '../../src/app.module';
import { createApp } from '../../src/create-app';
import { loadConfig } from '../../src/infrastructure/config/app-config';
import { TEST_COLLECTOR_ID } from '../fakes/fake-checkout-gateway';

// Fresh keys per test run: no key-shaped literal lives in the repository.
export const CLIENT_KEY = randomBytes(24).toString('base64url');
export const OPERATOR_KEY = randomBytes(24).toString('base64url');

/** Enables card payments in tests; the provider itself is always replaced by a fake. */
export const TEST_CARD_ENV = {
  MP_ACCESS_TOKEN: `TEST-${randomBytes(16).toString('hex')}`,
  MP_WEBHOOK_SECRET: randomBytes(16).toString('hex'),
  MP_COLLECTOR_ID: TEST_COLLECTOR_ID,
};

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export interface TestApp {
  app: NestExpressApplication;
  logs: () => string;
}

// nestjs-pino builds one pino-http instance per process, bound to the first app's destination, so every app
// a test file starts logs here; each TestApp reads the lines written since it started.
const captured: string[] = [];
const logDestination = new PassThrough();
logDestination.on('data', (chunk: Buffer) => captured.push(chunk.toString()));

/** The real application wiring, pointed at a throwaway database, with log lines captured for assertions. */
export async function startTestApp(
  databaseUrl: string,
  env: Record<string, string> = {},
  overrides: Omit<AppOverrides, 'logDestination'> = {},
): Promise<TestApp> {
  const firstChunk = captured.length;

  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    API_KEYS: `client:${sha256(CLIENT_KEY)},operator:${sha256(OPERATOR_KEY)}:settle`,
    LOG_LEVEL: 'info',
    ...env,
  });
  const app = await createApp(config, { ...overrides, logDestination });
  await app.init();
  return { app, logs: () => captured.slice(firstChunk).join('') };
}
