import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { SettleCardPaymentUseCase } from '../../src/application/use-cases/settle-card-payment.use-case';
import { ProviderPayment } from '../../src/application/ports/provider-payment-reader';
import { Payment } from '../../src/domain/payment/payment';
import { PrismaClient } from '../../src/generated/prisma/client';
import { createPrismaClient } from '../../src/infrastructure/persistence/prisma-client.factory';
import { PrismaPaymentRepository } from '../../src/infrastructure/persistence/prisma-payment.repository';
import { PrismaProviderAnomalyLog } from '../../src/infrastructure/persistence/prisma-provider-anomaly-log';
import { TEST_COLLECTOR_ID } from '../fakes/fake-checkout-gateway';
import { FakeProviderPaymentReader } from '../fakes/fake-provider-payment-reader';
import { RecordingAuditLog } from '../fakes/recording-audit-log';
import { MigratedDatabase, startMigratedPostgres } from '../support/postgres';

/** Runs the role script the same way docker-compose.yml's migrate job does, as the schema owner. */
function provisionAppRole(ownerUrl: string): void {
  execSync('npx prisma db execute --file prisma/compose-app-role.sql', {
    cwd: `${__dirname}/../..`,
    env: { ...process.env, DATABASE_URL: ownerUrl, CHECKPOINT_DISABLE: '1' },
    stdio: 'pipe',
  });
}

/** The login the script provisions; the password is the local-only one docker-compose.yml also uses. */
function appRoleUrl(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = 'payments_app';
  url.password = 'payments_app';
  return url.toString();
}

const REFUSED = /permission denied/;

// What the API's queries need, and nothing else: no DELETE, and the anomaly evidence is append-only.
const INTENDED_GRANTS = [
  { table_name: 'payments', privilege_type: 'INSERT' },
  { table_name: 'payments', privilege_type: 'SELECT' },
  { table_name: 'payments', privilege_type: 'UPDATE' },
  { table_name: 'provider_anomalies', privilege_type: 'INSERT' },
];

/**
 * The API's database role, provisioned by the real script: the application's own paths (repository,
 * settlement use case, anomaly adapter) must work as payments_app, and nothing beyond them. Outcomes are read
 * through a separate owner connection, because payments_app is not allowed to read the anomaly evidence.
 */
describe('The Compose API role (payments_app) against PostgreSQL', () => {
  let database: MigratedDatabase;
  let owner: PrismaClient;
  let app: PrismaClient;
  let lastProviderId = 60_000;

  beforeAll(async () => {
    database = await startMigratedPostgres();
    provisionAppRole(database.url);
    owner = createPrismaClient(database.url);
    app = createPrismaClient(appRoleUrl(database.url));
  });

  afterAll(async () => {
    await app?.$disconnect();
    await owner?.$disconnect();
    await database?.container.stop();
  });

  /** A pending card payment recorded as payments_app, and its settlement, which also runs as payments_app. */
  async function pendingSettlement(overrides: Partial<ProviderPayment> = {}) {
    const payments = new PrismaPaymentRepository(app);
    const id = randomUUID();
    const at = new Date();
    await payments.insert(
      Payment.restore({
        id,
        cpf: '12345678909',
        description: 'Pedido cartão',
        amountCents: 1000,
        paymentMethod: 'CREDIT_CARD',
        status: 'PENDING',
        failureReason: null,
        providerPreferenceId: `pref-${id}`,
        checkoutUrl: `https://checkout.example/${id}`,
        providerPaymentId: null,
        version: 0,
        createdAt: at,
        updatedAt: at,
      }),
    );
    const reader = new FakeProviderPaymentReader();
    const providerPaymentId = String((lastProviderId += 1));
    reader.willReturn({
      id: providerPaymentId,
      status: 'approved',
      outcome: 'APPROVED',
      externalReference: id,
      amountCents: 1000,
      currency: 'BRL',
      paymentType: 'credit_card',
      collectorId: TEST_COLLECTOR_ID,
      ...overrides,
    });
    const settlement = new SettleCardPaymentUseCase(
      payments,
      reader,
      new PrismaProviderAnomalyLog(app),
      new RecordingAuditLog(),
      TEST_COLLECTOR_ID,
    );
    return { id, providerPaymentId, settle: () => settlement.execute({ providerPaymentId }) };
  }

  /** Read through the owner: the exact table grants, and whether the role could create objects in the schema. */
  async function privileges() {
    const grants = await owner.$queryRaw<{ table_name: string; privilege_type: string }[]>`
      SELECT table_name::text, privilege_type::text FROM information_schema.role_table_grants
      WHERE grantee = 'payments_app' ORDER BY table_name, privilege_type`;
    const [schema] = await owner.$queryRaw<{ can_create: boolean }[]>`
      SELECT has_schema_privilege('payments_app', 'public', 'CREATE') AS can_create`;
    return { grants, canCreateInSchema: schema?.can_create };
  }

  it('is a plain login: no superuser, no database or role creation, no row-level-security bypass', async () => {
    const [role] = await owner.$queryRaw<Record<string, boolean>[]>`
      SELECT rolsuper, rolcanlogin, rolcreatedb, rolcreaterole, rolbypassrls
      FROM pg_roles WHERE rolname = 'payments_app'`;

    expect(role).toEqual({
      rolsuper: false,
      rolcanlogin: true,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
    });
  });

  it('holds exactly the table grants the API needs, and cannot create objects in the schema', async () => {
    expect(await privileges()).toEqual({ grants: INTENDED_GRANTS, canCreateInSchema: false });
  });

  it('records and settles a card payment through the application paths', async () => {
    const { id, providerPaymentId, settle } = await pendingSettlement();

    await expect(settle()).resolves.toEqual({ kind: 'APPLIED', paymentId: id });

    expect(await owner.payment.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'PAID',
      providerPaymentId,
      version: 1,
    });
  });

  it('keeps anomaly evidence it cannot read back, once per observation', async () => {
    const { id, providerPaymentId, settle } = await pendingSettlement({ paymentType: 'account_money' });

    await expect(settle()).resolves.toEqual({ kind: 'MISMATCH', paymentId: id });
    await expect(settle()).resolves.toEqual({ kind: 'MISMATCH', paymentId: id });

    expect(await owner.providerAnomaly.findMany({ where: { providerPaymentId } })).toEqual([
      expect.objectContaining({ kind: 'MISMATCH', paymentId: id, mismatches: ['paymentType'] }),
    ]);
    expect(await owner.payment.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'PENDING' });
    await expect(app.providerAnomaly.findMany()).rejects.toThrow(REFUSED);
  });

  it('cannot delete payments or read the migration history', async () => {
    await expect(app.payment.deleteMany()).rejects.toThrow(REFUSED);
    await expect(app.$queryRaw`SELECT 1 FROM _prisma_migrations`).rejects.toThrow(REFUSED);
  });

  it('restores exactly the intended privileges when it runs again, as on every compose up', async () => {
    // Drift a person might introduce by hand; the next run of the script must remove it.
    await owner.$executeRaw`GRANT DELETE, UPDATE, TRUNCATE ON provider_anomalies TO payments_app`;
    await owner.$executeRaw`GRANT CREATE ON SCHEMA public TO payments_app`;

    provisionAppRole(database.url);

    expect(await privileges()).toEqual({ grants: INTENDED_GRANTS, canCreateInSchema: false });
    const { id, settle } = await pendingSettlement();
    await expect(settle()).resolves.toEqual({ kind: 'APPLIED', paymentId: id });
  });
});
