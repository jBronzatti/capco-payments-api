// Sandbox feasibility probe: creates ONE Checkout Pro preference with the test credentials in .env, through
// the application's real adapter, and prints only non-secret facts. Usage: npm run mp:probe
// It never prints the access token or the webhook secret, and it creates no payment in the database.
// Reads MP_ACCESS_TOKEN from .env.mp (if present) or .env; both are gitignored.
import { randomUUID } from 'node:crypto';

// `.env.mp` can hold just the access token while the API's .env stays PIX-only: the API refuses to boot
// with a partial Mercado Pago configuration, but this probe only needs the token. Earlier files win.
for (const file of ['.env.mp', '.env']) {
  try {
    process.loadEnvFile(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const { MercadoPagoCheckoutGateway } =
  await import('../dist/infrastructure/mercado-pago/mercado-pago-checkout.gateway.js');
const { Payment } = await import('../dist/domain/payment/payment.js');

const accessToken = process.env.MP_ACCESS_TOKEN?.trim();
if (!accessToken) {
  console.error('MP_ACCESS_TOKEN is not set in .env.mp or .env; nothing to probe.');
  process.exit(1);
}

const now = new Date();
const payment = Payment.restore({
  id: randomUUID(),
  cpf: '12345678909', // synthetic fixture; not sent to Mercado Pago
  description: 'Sandbox probe',
  amountCents: 100,
  paymentMethod: 'CREDIT_CARD',
  status: 'PENDING',
  failureReason: null,
  providerPreferenceId: null,
  checkoutUrl: null,
  providerPaymentId: null,
  version: 0,
  createdAt: now,
  updatedAt: now,
});

const gateway = new MercadoPagoCheckoutGateway({
  accessToken,
  checkoutTtlMinutes: 30,
  requestTimeoutMs: 8000,
});
try {
  const session = await gateway.createCheckout(payment);
  const configuredCollector = process.env.MP_COLLECTOR_ID?.trim();
  console.log('Preference created.');
  console.log(`  external_reference (our payment id): ${payment.id}`);
  console.log(`  preference id: ${session.preferenceId}`);
  console.log(`  collector id (your Mercado Pago user id, not a secret): ${session.collectorId}`);
  console.log(
    `  matches MP_COLLECTOR_ID in .env: ${configuredCollector ? String(configuredCollector === session.collectorId) : 'MP_COLLECTOR_ID not set'}`,
  );
  console.log(`  checkout URL: ${session.checkoutUrl}`);
} catch (error) {
  console.error(`Preference creation failed: ${error.name}: ${error.message}`);
  process.exit(1);
}
