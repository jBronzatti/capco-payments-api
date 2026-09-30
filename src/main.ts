import 'reflect-metadata';
import { createApp } from './create-app';
import { ConfigError, loadConfig } from './infrastructure/config/app-config';

function loadDotEnvIfPresent(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    // Containers and CI provide the environment directly; only a missing .env is expected.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function bootstrap(): Promise<void> {
  loadDotEnvIfPresent();
  const config = loadConfig(process.env);
  const app = await createApp(config);
  await app.listen(config.port, config.host);
}

bootstrap().catch((error: unknown) => {
  // Fail fast; configuration errors name variables, never their values.
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
