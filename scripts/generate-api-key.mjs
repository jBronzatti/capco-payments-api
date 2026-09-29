// Usage: npm run key:generate -- <key-id> [--settle]
// Prints a new high-entropy API key once, and the API_KEYS entry (id:sha256[:settle]) for the server config.
import { createHash, randomBytes } from 'node:crypto';

const [id, ...flags] = process.argv.slice(2);
if (!id || !/^[a-z0-9_-]{1,32}$/.test(id)) {
  console.error('Usage: npm run key:generate -- <key-id> [--settle]   (key id: [a-z0-9_-]{1,32})');
  process.exit(1);
}

const key = randomBytes(32).toString('base64url');
const hash = createHash('sha256').update(key).digest('hex');
const permission = flags.includes('--settle') ? ':settle' : '';

console.log(`API key (hand it to the client; it is not stored anywhere): ${key}`);
console.log(`API_KEYS entry for .env: ${id}:${hash}${permission}`);
