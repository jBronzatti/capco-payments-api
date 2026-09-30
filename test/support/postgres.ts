import { execSync } from 'node:child_process';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

// Same pinned image as docker-compose.yml.
const POSTGRES_IMAGE =
  'postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';

export interface MigratedDatabase {
  container: StartedPostgreSqlContainer;
  url: string;
}

/**
 * A throwaway PostgreSQL container with the real migrations applied. Tests never receive the
 * developer's DATABASE_URL, so they cannot reset or pollute a regular database.
 */
export async function startMigratedPostgres(): Promise<MigratedDatabase> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();
  execSync('npx prisma migrate deploy', {
    cwd: `${__dirname}/../..`,
    env: { ...process.env, DATABASE_URL: url, CHECKPOINT_DISABLE: '1' },
    stdio: 'pipe',
  });
  return { container, url };
}
