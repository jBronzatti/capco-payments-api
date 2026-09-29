import { createHash, randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from '../../src/create-app';
import { loadConfig } from '../../src/infrastructure/config/app-config';

// Fresh keys per test run: no key-shaped literal lives in the repository.
export const CLIENT_KEY = randomBytes(24).toString('base64url');
export const OPERATOR_KEY = randomBytes(24).toString('base64url');

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export interface TestApp {
  app: NestExpressApplication;
  logs: () => string;
}

/** The real application wiring, pointed at a throwaway database, with log lines captured for assertions. */
export async function startTestApp(databaseUrl: string, env: Record<string, string> = {}): Promise<TestApp> {
  const captured: string[] = [];
  const logDestination = new PassThrough();
  logDestination.on('data', (chunk: Buffer) => captured.push(chunk.toString()));

  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    API_KEYS: `client:${sha256(CLIENT_KEY)},operator:${sha256(OPERATOR_KEY)}:settle`,
    LOG_LEVEL: 'info',
    ...env,
  });
  const app = await createApp(config, { logDestination });
  await app.init();
  return { app, logs: () => captured.join('') };
}
